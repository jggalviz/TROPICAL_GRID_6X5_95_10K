'use strict';

/**
 * Rasteriza public/src/assets/background.svg (1920x1080) y exporta candidatos
 * WebP con distintas calidades usando Chrome headless via CDP.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = 4351;
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CAPTURE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
  img { display: block; width: 100vw; height: 100vh; object-fit: cover; }
</style></head><body><img id="bg" src="/src/assets/background.svg" alt=""></body></html>`;

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/__capture') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(CAPTURE_HTML);
  }
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(filePath, (error, buffer) => {
    if (error) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buffer);
  });
});

const findChrome = () => [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
].find((candidate) => candidate && fs.existsSync(candidate));

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => socket.close() };
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Sin Chrome');
  await new Promise((resolve) => server.listen(PORT, resolve));
  const userDataDir = path.join(ROOT, '.sim-chrome');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--force-device-scale-factor=1', '--no-default-browser-check',
    '--remote-debugging-port=9351', `--user-data-dir=${userDataDir}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let attempt = 0; attempt < 60 && !targets; attempt += 1) {
      await sleep(250);
      try {
        targets = await (await fetch('http://127.0.0.1:9351/json/list')).json();
      } catch {
        targets = null;
      }
    }
    if (!targets) throw new Error('CDP no disponible');
    const cdp = connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__capture` });
    await sleep(1500);
    const decoded = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("bg").decode().then(() => document.getElementById("bg").naturalWidth + "x" + document.getElementById("bg").naturalHeight)',
      awaitPromise: true,
      returnByValue: true
    });
    console.log('SVG natural:', decoded.result.value);

    for (const quality of [90, 85, 80, 75, 70]) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'webp', quality, fromSurface: true, captureBeyondViewport: false });
      const buffer = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(ROOT, `.bg-q${quality}.webp`), buffer);
      console.log(`q${quality}: ${(buffer.length / 1024).toFixed(1)} KB`);
    }

    cdp.close();
  } finally {
    child.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
