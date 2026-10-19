// Drives the management UI in headless Chrome: open an env, click "读取环境当前 Cookie".
// node scripts/ui-cookie-check.mjs <baseUrl> <out.png>
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CDPConnection } from '../src/cdp.js';

const base = process.argv[2] || 'http://127.0.0.1:50360';
const out = process.argv[3] || 'scripts/cookie-drawer.png';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 19334;
const profile = 'C:\\Users\\yzc\\AppData\\Local\\Temp\\fp-ui-cookie';

const proc = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let version = null;
for (let i = 0; i < 80; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await wait(250);
  }
}
if (!version) {
  console.log('chrome did not start');
  proc.kill();
  process.exit(1);
}

const conn = await CDPConnection.connect(version.webSocketDebuggerUrl);
const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
const send = (m, p) => conn.send(m, p, sessionId);
const ev = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/#/profiles?t=${Date.now()}` });
await wait(3000);

console.log('rows:', await ev(`document.querySelectorAll('#rows tr').length`));
console.log('edit buttons:', await ev(`document.querySelectorAll('#rows [data-act="edit"]').length`));
await ev(`document.querySelector('#rows [data-act="edit"]').click()`);
await wait(800);
console.log('drawer open:', await ev(`!!document.querySelector('#ck-load')`));
console.log('status before:', await ev(`document.querySelector('#ck-status')?.textContent || ''`));

await ev(`document.querySelector('#ck-load').click()`);
await wait(4000);
const text = await ev(`document.querySelector('[name=cookies]').value`);
const status = await ev(`document.querySelector('#ck-status')?.textContent || ''`);
console.log('status after:', status);
console.log('textarea chars:', text.length);
console.log('sample:', text.slice(0, 220).replace(/\n/g, ' '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('screenshot ->', out);

conn.close();
proc.kill();
process.exit(0);
