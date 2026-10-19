import fs from 'node:fs';
// Throwaway check: launch one existing profile with the SunBrowser kernel and read back the
// fingerprint the kernel reports. Run: node scripts/try-kernel.mjs
import { createApp } from '../src/app.js';

const ID = process.argv[2] || 'kk1k7eh';
const app = createApp({ dataDir: './data', port: 0, debug: true });
await app.listen(0);
console.log('listening on', app.baseUrl);
try {
  app.store.updateSettings({ kernel: 'sunbrowser' });
  console.log('settings.kernel =', app.store.settings.kernel);
  const info = await app.launcher.start(ID, { openUrls: ['about:blank'] });
  console.log('started:', JSON.stringify({ ws: info.ws, pid: info.pid, tz: info.fingerprint.timezone, langs: info.fingerprint.languages }));

  const inst = app.launcher.running.get(ID);
  const sa = inst.proc.spawnargs || [];
  fs.writeFileSync('scripts/launcher-argv.json', JSON.stringify(sa, null, 2));
  console.log('ARGV[' + sa.length + ']', sa.filter((a) => /^--(protected-(webglfp|staticconfig|dynamicconfig|cookiesfile)|user-data-dir|extended-parameters)/.test(a)).map((a) => a.slice(0, 140)));
  const { targetInfos } = await inst.conn.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await inst.conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const expr = `JSON.stringify({
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    langs: navigator.languages.join(','),
    hc: navigator.hardwareConcurrency,
    dm: navigator.deviceMemory,
    ua: navigator.userAgent,
    platform: navigator.platform,
    webglVendor: (()=>{try{const c=document.createElement('canvas');const g=c.getContext('webgl');const d=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(d.UNMASKED_VENDOR_WEBGL)}catch(e){return 'ERR:'+e.message}})(),
    canvas: (()=>{const c=document.createElement('canvas');const g=c.getContext('2d');g.fillText('fp',10,20);g.getImageData(0,0,10,10);return c.toDataURL().split('').reduce((a,b)=>a+b.charCodeAt(0),0)})(),
    webdriver: navigator.webdriver
  })`;
  const r = await inst.conn.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  console.log('in-page:', r.result.value);
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  process.exit(process.exitCode || 0);
}
