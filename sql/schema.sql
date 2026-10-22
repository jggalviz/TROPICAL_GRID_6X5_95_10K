-- ============================================================================
--  TROPICAL_GRID_6X5_95_10K  -  ESQUEMA SUPABASE (PostgreSQL 15+)
-- ----------------------------------------------------------------------------
--  Ejecutar en el SQL Editor del proyecto (o con `supabase db push`).
--  Todo el dinero se guarda en CENTIMOS ENTEROS (BIGINT). Nunca floats.
--
--  Modelo de seguridad:
--    * RLS activado en todas las tablas y SIN politicas para `anon`.
--    * Solo el backend (service_role) accede; el navegador JAMAS toca la BD.
--    * El debito/credito es atomico dentro de `play_spin` (SECURITY DEFINER)
--      con bloqueo de fila del jugador (SELECT ... FOR UPDATE), lo que
--      serializa las peticiones concurrentes de un mismo jugador.
--    * La idempotencia se garantiza con (player_id, round_ref) UNIQUE.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
--  JUGADORES
-- ----------------------------------------------------------------------------
create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  external_id   text        not null unique,
  display_name  text        not null default 'Player',
  currency      text        not null default 'EUR',
  balance_cents bigint      not null default 0 check (balance_cents >= 0),
  status        text        not null default 'ACTIVE'
                            check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  total_wagered_cents bigint not null default 0 check (total_wagered_cents >= 0),
  total_won_cents     bigint not null default 0 check (total_won_cents >= 0),
  spin_count          bigint not null default 0 check (spin_count >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.players is
  'Saldo autoritativo del jugador. Solo modificable por el backend.';

-- ----------------------------------------------------------------------------
--  RONDAS JUGADAS (registro de auditoria completo)
-- ----------------------------------------------------------------------------
create table if not exists public.game_rounds (
  id                    uuid primary key default gen_random_uuid(),
  player_id             uuid not null references public.players (id) on delete restrict,
  round_ref             text,
  mode                  text not null check (mode in ('BASE', 'BUY_FEATURE')),
  bet_cents             bigint not null check (bet_cents > 0),
  wager_cents           bigint not null check (wager_cents > 0),
  win_cents             bigint not null default 0 check (win_cents >= 0),
  balance_before_cents  bigint not null check (balance_before_cents >= 0),
  balance_after_cents   bigint not null check (balance_after_cents >= 0),
  multiplier            integer,
  engine_version        text not null,
  paytable_version      text not null,
  certified_rtp         numeric(7, 5),
  server_seed           text,
  server_seed_hash      text,
  client_seed           text,
  rng_hash              text,
  result                jsonb not null,
  created_at            timestamptz not null default now()
);

create unique index if not exists game_rounds_player_ref_uidx
  on public.game_rounds (player_id, round_ref)
  where round_ref is not null;

create index if not exists game_rounds_player_created_idx
  on public.game_rounds (player_id, created_at desc);

comment on table public.game_rounds is
  'Una fila por ronda resuelta. Contiene el payload completo devuelto al cliente '
  '(cuadriculas, cascadas, semillas y versiones) para auditoria GLI-19.';

-- ----------------------------------------------------------------------------
--  LIBRO MAYOR (doble entrada: apuesta y premio como movimientos separados)
-- ----------------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id                  bigserial primary key,
  player_id           uuid not null references public.players (id) on delete restrict,
  round_id            uuid references public.game_rounds (id) on delete restrict,
  entry_type          text not null
                      check (entry_type in ('BET', 'WIN', 'BONUS_BUY', 'ADJUSTMENT', 'ROLLBACK')),
  amount_cents        bigint not null,
  balance_after_cents bigint not null check (balance_after_cents >= 0),
  note                text,
  created_at          timestamptz not null default now()
);

create index if not exists ledger_entries_player_created_idx
  on public.ledger_entries (player_id, created_at desc);

create index if not exists ledger_entries_round_idx
  on public.ledger_entries (round_id);

comment on table public.ledger_entries is
  'Libro mayor inmutable. amount_cents es con signo (negativo = debito).';

-- ----------------------------------------------------------------------------
--  RPC 1: play_spin  -> debita apuesta, acredita premio y registra la ronda
--  Todo ocurre en UNA transaccion. Si algo falla, no se mueve dinero.
-- ----------------------------------------------------------------------------
create or replace function public.play_spin(
  p_player_id        uuid,
  p_round_ref        text,
  p_mode             text,
  p_bet_cents        bigint,
  p_wager_cents      bigint,
  p_win_cents        bigint,
  p_multiplier       integer,
  p_engine_version   text,
  p_paytable_version text,
  p_certified_rtp    numeric,
  p_server_seed      text,
  p_server_seed_hash text,
  p_client_seed      text,
  p_rng_hash         text,
  p_result           jsonb
)
returns table (round_id uuid, balance_cents bigint, replayed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player   public.players%rowtype;
  v_existing public.game_rounds%rowtype;
  v_round_id uuid;
  v_before   bigint;
  v_balance  bigint;
begin
  /* --- Validaciones defensivas (el backend ya valida; ultima red) --- */
  if p_mode is null or p_mode not in ('BASE', 'BUY_FEATURE') then
    raise exception 'INVALID_MODE' using errcode = 'P0001';
  end if;
  if p_bet_cents is null or p_bet_cents <= 0
     or p_wager_cents is null or p_wager_cents <= 0 then
    raise exception 'INVALID_STAKE' using errcode = 'P0001';
  end if;
  if p_win_cents is null or p_win_cents < 0 then
    raise exception 'INVALID_WIN' using errcode = 'P0001';
  end if;

  /* --- Bloqueo de fila: serializa las rondas concurrentes del jugador --- */
  select * into v_player
    from public.players
   where id = p_player_id
     for update;
  if not found then
    raise exception 'PLAYER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_player.status <> 'ACTIVE' then
    raise exception 'PLAYER_BLOCKED' using errcode = 'P0001';
  end if;

  /* --- Idempotencia: misma round_ref => se devuelve la ronda original --- */
  if p_round_ref is not null then
    select * into v_existing
      from public.game_rounds
     where player_id = p_player_id
       and round_ref = p_round_ref;
    if found then
      return query select v_existing.id, v_player.balance_cents, true;
      return;
    end if;
  end if;

  if v_player.balance_cents < p_wager_cents then
    raise exception 'INSUFFICIENT_FUNDS' using errcode = 'P0001';
  end if;

  v_before  := v_player.balance_cents;
  v_balance := v_before - p_wager_cents + p_win_cents;

  insert into public.game_rounds (
    player_id, round_ref, mode, bet_cents, wager_cents, win_cents,
    balance_before_cents, balance_after_cents, multiplier,
    engine_version, paytable_version, certified_rtp,
    server_seed, server_seed_hash, client_seed, rng_hash, result
  ) values (
    p_player_id, p_round_ref, p_mode, p_bet_cents, p_wager_cents, p_win_cents,
    v_before, v_balance, p_multiplier,
    p_engine_version, p_paytable_version, p_certified_rtp,
    p_server_seed, p_server_seed_hash, p_client_seed, p_rng_hash, p_result
  ) returning id into v_round_id;

  insert into public.ledger_entries
    (player_id, round_id, entry_type, amount_cents, balance_after_cents, note)
  values (
    p_player_id, v_round_id,
    case when p_mode = 'BUY_FEATURE' then 'BONUS_BUY' else 'BET' end,
    -p_wager_cents, v_before - p_wager_cents, p_mode
  );

  if p_win_cents > 0 then
    insert into public.ledger_entries
      (player_id, round_id, entry_type, amount_cents, balance_after_cents, note)
    values (p_player_id, v_round_id, 'WIN', p_win_cents, v_balance, 'Premio de ronda');
  end if;

  update public.players
     set balance_cents       = v_balance,
         total_wagered_cents = total_wagered_cents + p_wager_cents,
         total_won_cents     = total_won_cents + p_win_cents,
         spin_count          = spin_count + 1,
         updated_at          = now()
   where id = p_player_id;

  return query select v_round_id, v_balance, false;
end;
$$;
comment on function public.play_spin is
  'Resuelve una ronda de forma atomica: idempotencia por round_ref, debito de '
  'apuesta, credito de premio, libro mayor y actualizacion de saldo.';

-- ----------------------------------------------------------------------------
--  RPC 2: adjust_balance  -> movimientos administrativos / seed de pruebas
-- ----------------------------------------------------------------------------
create or replace function public.adjust_balance(
  p_player_id    uuid,
  p_amount_cents bigint,
  p_note         text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player  public.players%rowtype;
  v_balance bigint;
begin
  select * into v_player from public.players where id = p_player_id for update;
  if not found then
    raise exception 'PLAYER_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_balance := v_player.balance_cents + p_amount_cents;
  if v_balance < 0 then
    raise exception 'INSUFFICIENT_FUNDS' using errcode = 'P0001';
  end if;

  update public.players
     set balance_cents = v_balance,
         updated_at = now()
   where id = p_player_id;

  insert into public.ledger_entries
    (player_id, round_id, entry_type, amount_cents, balance_after_cents, note)
  values (p_player_id, null, 'ADJUSTMENT', p_amount_cents, v_balance, p_note);

  return v_balance;
end;
$$;

-- ----------------------------------------------------------------------------
--  RLS: sin politicas => `anon` y `authenticated` no pueden leer ni escribir.
--  El backend usa la clave service_role, que omite RLS.
-- ----------------------------------------------------------------------------
alter table public.players        enable row level security;
alter table public.game_rounds    enable row level security;
alter table public.ledger_entries enable row level security;

revoke all on public.players        from anon, authenticated;
revoke all on public.game_rounds    from anon, authenticated;
revoke all on public.ledger_entries from anon, authenticated;

revoke all on function public.play_spin(uuid, text, text, bigint, bigint, bigint,
  integer, text, text, numeric, text, text, text, text, jsonb) from public;
revoke all on function public.adjust_balance(uuid, bigint, text) from public;
grant execute on function public.play_spin(uuid, text, text, bigint, bigint, bigint,
  integer, text, text, numeric, text, text, text, text, jsonb) to service_role;
grant execute on function public.adjust_balance(uuid, bigint, text) to service_role;


