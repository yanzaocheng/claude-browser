// Opens the project UI in headless Chrome via CDP, checks the kernel selector exists,
// and writes a screenshot. Usage: node scripts/ui-check.mjs <baseUrl> <out.png>
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CDPConnection } from '../src/cdp.js';

const base = process.argv[2] || 'http://127.0.0.1:18080';
const out = process.argv[3] || 'scripts/settings-shot.png';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 19333;
const profile = 'C:\\Users\\yzc\\AppData\\Local\\Temp\\fp-ui-check';

const proc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,1100',
  'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 60; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await wait(250);
  }
}
if (!version) {
  console.log('chrome headless did not start');
  proc.kill();
  process.exit(1);
}

const conn = await CDPConnection.connect(version.webSocketDebuggerUrl);
const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
await conn.send('Page.enable', {}, sessionId);
await conn.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
await conn.send('Page.navigate', { url: `${base}/#/settings` }, sessionId);
await wait(3500);

const check = await conn.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasKernelSelect: !!document.querySelector('select[name="kernel"]'),
    kernelValue: document.querySelector('select[name="kernel"]')?.value ?? null,
    options: [...(document.querySelectorAll('select[name="kernel"] option') || [])].map(o => o.textContent.trim()),
    hasSunPath: !!document.querySelector('input[name="sunBrowserPath"]'),
    hint: (document.querySelector('select[name="kernel"]')?.closest('.field')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
  })`,
  returnByValue: true,
}, sessionId);
console.log('UI CHECK:', check.result.value);

const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('screenshot ->', out);

conn.close();
proc.kill();
process.exit(0);
