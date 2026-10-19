// Prints the WebGL / Client-Hints fingerprint a profile actually reports.
// node scripts/fp-report.mjs <profileId> <kernel|chrome>
import { createApp } from '../src/app.js';

const id = process.argv[2] || 'krsvjej';
const mode = (process.argv[3] || 'kernel').toLowerCase();
const app = createApp({ dataDir: './data', port: 0 });
await app.listen(0);

const EXPR = `(async () => {
  const out = {};
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  out.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
  out.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  out.version = gl.getParameter(gl.VERSION);
  out.shading = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
  out.extCount = gl.getSupportedExtensions().length;
  out.ext = gl.getSupportedExtensions().sort();
  const params = {};
  for (const n of ['MAX_TEXTURE_SIZE','MAX_RENDERBUFFER_SIZE','MAX_VIEWPORT_DIMS','MAX_VERTEX_ATTRIBS',
    'MAX_VERTEX_UNIFORM_VECTORS','MAX_FRAGMENT_UNIFORM_VECTORS','MAX_VARYING_VECTORS',
    'MAX_COMBINED_TEXTURE_IMAGE_UNITS','MAX_TEXTURE_IMAGE_UNITS','MAX_CUBE_MAP_TEXTURE_SIZE',
    'MAX_VERTEX_TEXTURE_IMAGE_UNITS','ALIASED_LINE_WIDTH_RANGE','ALIASED_POINT_SIZE_RANGE',
    'MAX_3D_TEXTURE_SIZE','MAX_ARRAY_TEXTURE_LAYERS','MAX_ELEMENT_INDEX','MAX_TEXTURE_MAX_ANISOTROPY_EXT']) {
    if (n.endsWith('_EXT')) { const e = gl.getExtension('EXT_texture_filter_anisotropic'); if (e) params[n] = gl.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT); continue; }
    const v = gl.getParameter(gl[n]);
    params[n] = Array.isArray(v) || v instanceof Float32Array || v instanceof Int32Array ? Array.from(v) : v;
  }
  out.params = params;
  out.webgpu = 'gpu' in navigator ? !!(await navigator.gpu.requestAdapter?.().catch(() => null)) : false;
  try {
    const he = await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platform','platformVersion','uaFullVersion','fullVersionList','wow64']);
    out.ch = he;
    out.brandsLow = navigator.userAgentData.brands;
  } catch (e) { out.ch = 'n/a: ' + e.message; }
  try {
    const r = await fetch('https://httpbin.org/headers', { cache: 'no-store' });
    const j = await r.json();
    out.headers = j.headers;
  } catch (e) { out.headers = 'n/a: ' + e.message; }
  out.ua = navigator.userAgent;
  out.hc = navigator.hardwareConcurrency;
  out.dm = navigator.deviceMemory;
  out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return JSON.stringify(out, null, 1);
})()`;

try {
  if (mode === 'chrome') app.store.updateSettings({ kernel: '' });
  else app.store.updateSettings({ kernel: 'sunbrowser' });
  await app.launcher.start(id, { openUrls: [app.baseUrl + '/'], ipTab: false });
  const conn = app.launcher.running.get(id).conn;
  const { targetInfos } = await conn.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const r = await conn.send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true }, sessionId);
  console.log(`===== ${mode} / ${id} =====`);
  console.log(r.result.value);
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  process.exit(process.exitCode || 0);
}
