'use strict';

/** Verifica el fondo WebP: MIME real de Express, recursos descargados y render. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./test/helpers/server');

const ROOT = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const PROBE = `(() => {
  const css = getComputedStyle(document.body);
  const images = performance.getEntriesByType('resource')
    .filter((item) => item.name.includes('background.'))
    .map((item) => ({ name: item.name.split('/').pop(), size: item.transferSize || item.encodedBodySize, duration: Math.round(item.duration) }));
  return { backgroundImage: css.backgroundImage, backgroundSize: css.backgroundSize, backgroundAttachment: css.backgroundAttachment, images };
})()`;

async function main() {
  const server = await startServer();
  const chrome = findChrome();
  if (!chrome) throw new Error('Sin Chrome');

  try {
    for (const route of ['/src/assets/background.webp', '/src/assets/background.svg']) {
      const response = await fetch(server.baseUrl + route);
      const body = await response.arrayBuffer();
      console.log(route, '| status', response.status, '| type', response.headers.get('content-type'), '| bytes', body.byteLength);
    }

    const userDataDir = path.join(ROOT, '.sim-chrome');
    fs.rmSync(userDataDir, { recursive: true, force: true });
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=9352',
      `--user-data-dir=${userDataDir}`, 'about:blank'
    ], { stdio: 'ignore' });

    try {
      let targets = null;
      for (let attempt = 0; attempt < 60 && !targets; attempt += 1) {
        await sleep(250);
        try {
          targets = await (await fetch('http://127.0.0.1:9352/json/list')).json();
        } catch {
          targets = null;
        }
      }
      if (!targets) throw new Error('CDP no disponible');
      const cdp = connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
      await cdp.ready;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');

      for (const [label, width, height] of [['1440x900', 1440, 900], ['390x844', 390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 });
        await cdp.send('Page.navigate', { url: `${server.baseUrl}/` });
        await sleep(2000);
        const probe = (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
        console.log(label, JSON.stringify(probe));
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(ROOT, `.verify-bg-${label}.png`), Buffer.from(shot.data, 'base64'));
      }
      cdp.close();
    } finally {
      child.kill();
    }
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
