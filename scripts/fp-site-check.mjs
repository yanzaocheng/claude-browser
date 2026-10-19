// Opens https://fp.predix.icu in a profile and prints what that site reports.
// node scripts/fp-site-check.mjs <profileId> <kernel|chrome> [outFile]
import fs from 'node:fs';
import { createApp } from '../src/app.js';

const id = process.argv[2] || 'khkm4wg';
const mode = (process.argv[3] || 'kernel').toLowerCase();
const out = process.argv[4] || '';

const app = createApp({ dataDir: './data', port: 0 });
await app.listen(0);

try {
  app.store.updateSettings({ kernel: mode === 'kernel' ? 'sunbrowser' : '' });
  await app.launcher.start(id, { openUrls: ['https://fp.predix.icu/'], ipTab: false });
  const conn = app.launcher.running.get(id).conn;
  const { targetInfos } = await conn.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && /predix/.test(t.url)) || targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  // wait for the collector to finish: status text settles and #app has content
  let last = '';
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const snapshot = await evaluate(`JSON.stringify({
      status: document.querySelector('#status')?.textContent || '',
      len: (document.querySelector('#app')?.innerText || '').length,
      ready: document.readyState
    })`);
    if (snapshot === last) stable++;
    else stable = 0;
    last = snapshot;
    const s = JSON.parse(snapshot);
    if (s.len > 1500 && stable >= 3 && /完成|已|done/i.test(s.status + ' x')) break;
    if (s.len > 1500 && stable >= 6) break;
  }

  const text = await evaluate(`(document.querySelector('#app')?.innerText || '')`);
  const status = await evaluate(`document.querySelector('#status')?.textContent || ''`);
  const globals = await evaluate(`JSON.stringify(Object.keys(window).filter(k => /fp|report|result|last/i.test(k)))`);

  const payload = `===== ${mode} / ${id} =====\nstatus: ${status}\nglobals: ${globals}\n\n${text}\n`;
  if (out) fs.writeFileSync(out, payload, 'utf8');
  console.log(payload);
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  process.exit(process.exitCode || 0);
}
