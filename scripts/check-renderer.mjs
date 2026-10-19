import { createApp } from '../src/app.js';

const id = process.argv[2] || 'krsvjej';
const app = createApp({ dataDir: './data', port: 0 });
await app.listen(0);
try {
  app.store.updateSettings({ kernel: 'sunbrowser' });
  await app.launcher.start(id, { openUrls: ['about:blank'] });
  const conn = app.launcher.running.get(id).conn;
  const { targetInfos } = await conn.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const expression = `(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl');
    const d = g.getExtension('WEBGL_debug_renderer_info');
    const c2 = document.createElement('canvas');
    const g2 = c2.getContext('2d');
    g2.fillText('fp', 10, 20);
    g2.getImageData(0, 0, 10, 10);
    return JSON.stringify({
      vendor: g.getParameter(d.UNMASKED_VENDOR_WEBGL),
      renderer: g.getParameter(d.UNMASKED_RENDERER_WEBGL),
      canvas: c2.toDataURL().split('').reduce((a, b) => a + b.charCodeAt(0), 0),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hc: navigator.hardwareConcurrency,
      dm: navigator.deviceMemory,
    });
  })()`;
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  console.log('RESULT:', r.result.value);
} finally {
  await app.close();
  process.exit(0);
}
