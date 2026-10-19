// End-to-end: launches real (headless) Chrome profiles through the app and checks, from a separate
// CDP client (as Puppeteer would connect), what pages, frames and workers actually see.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { CDPConnection } from '../src/cdp.js';
import { findBrowsers } from '../src/browser-finder.js';
import { brandLists, speechVoices } from '../src/fingerprint.js';
import { sleep } from '../src/util.js';
import { startSocks5Proxy, startTargetServer } from './helpers/mock-proxies.js';

const chrome = findBrowsers().find((b) => b.kind === 'chrome');
// The same small fingerprint taken in a profile and in an unmodified Chrome (compared at the end).
const FP_SAMPLE = `
  const c = document.createElement('canvas'); c.width = 240; c.height = 60; const x = c.getContext('2d');
  x.textBaseline = 'top'; x.font = '14px Arial'; x.fillStyle = '#f60'; x.fillRect(125, 1, 62, 20);
  x.fillStyle = '#069'; x.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
  x.fillStyle = 'rgba(102, 204, 0, 0.7)'; x.fillText('Cwm fjordbank glyphs vext quiz', 4, 17);
  const canvas = c.toDataURL();
  const ctx = new OfflineAudioContext(1, 5000, 44100);
  const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor(); osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
  const data = (await ctx.startRendering()).getChannelData(0);
  let audio = 0; for (let i = 4500; i < 5000; i++) audio += Math.abs(data[i]);
  const s = document.createElement('span'); s.style.font = '16px Arial'; s.textContent = 'fingerprint text'; document.body.append(s);
  const width = s.getBoundingClientRect().width; s.remove();
  return { canvas, audio, width };`;
let profileSample = null;
const MAC_RENDERER = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';

/** Opens a tab the way Puppeteer's newPage() + goto() does, or attaches to an existing target. */
async function openPage(wsUrl, url, existingTargetId) {
  const conn = await CDPConnection.connect(wsUrl);
  const targetId = existingTargetId || (await conn.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  const s = conn.session(sessionId);
  if (!existingTargetId) await s.send('Page.navigate', { url });
  const evaluate = async (expression) => {
    const r = await s.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) {
    const ok = await evaluate(`return document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`).catch(() => false);
    if (ok) break;
    await sleep(100);
  }
  return { conn, s, evaluate, targetId, close: async () => { await conn.send('Target.closeTarget', { targetId }).catch(() => {}); conn.close(); } };
}

describe('fingerprint browser (headless Chrome)', { skip: !chrome && 'Chrome not installed', timeout: 180000 }, () => {
  let app, dataDir, target, socks, profile, info, page;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-e2e-'));
    target = await startTargetServer();
    socks = await startSocks5Proxy({
      username: 'u1',
      password: 'pw',
      hosts: { 'ip-api.com:80': `127.0.0.1:${target.port}`, 'target.test:80': `127.0.0.1:${target.port}` },
    });
    app = createApp({ dataDir, port: 0, debug: !!process.env.FPB_DEBUG });
    await app.listen();
    profile = app.profiles.create({
      name: 'e2e',
      startUrls: [`http://127.0.0.1:${target.port}/start-a`, `http://127.0.0.1:${target.port}/start-b`],
      proxy: { type: 'socks5', host: '127.0.0.1', port: socks.port, username: 'u1', password: 'pw' },
      fingerprint: {
        os: 'macos',
        platformVersion: '14.6.1',
        language: { mode: 'ip' },
        timezone: { mode: 'ip' },
        geolocation: { permission: 'allow', mode: 'ip' },
        webrtc: 'proxy',
        screen: { mode: 'custom', width: 1600, height: 900 },
        hardwareConcurrency: 6,
        deviceMemory: 4,
        webgl: { mode: 'custom', vendor: 'Google Inc. (Apple)', renderer: MAC_RENDERER },
        canvas: 'noise',
        audio: 'noise',
        clientRects: 'noise',
        seed: 12345,
      },
    });
    info = await app.launcher.start(profile.id, { headless: true });
    page = await openPage(info.ws, `http://127.0.0.1:${target.port}/page`);
  });

  after(async () => {
    await page?.close();
    await app?.close();
    await Promise.all([target?.close(), socks?.close()]);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('start URLs open in patched tabs', async () => {
    for (const p of ['/start-a', '/start-b']) {
      const t = (await page.conn.send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && x.url.endsWith(p));
      assert.ok(t, `tab ${p} missing`);
      const tab = await openPage(info.ws, t.url, t.targetId);
      try {
        assert.deepEqual(await tab.evaluate('return [navigator.deviceMemory, navigator.platform, navigator.webdriver]'), [4, 'MacIntel', false]);
      } finally {
        tab.conn.close();
      }
      assert.equal(target.log.find((l) => l.url === p).headers['sec-ch-ua-platform'], '"macOS"');
    }
  });

  test('IP lookup went through the proxy and drives timezone / language / geolocation', async () => {
    assert.equal(info.ipInfo.ip, '203.0.113.7');
    const r = await page.evaluate(`
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(p => res(p.coords), rej, { timeout: 5000 }));
      return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale,
               lang: navigator.language, langs: navigator.languages, lat: pos.latitude, lon: pos.longitude,
               offset: new Date('2024-01-01T00:00:00Z').getTimezoneOffset() };`);
    assert.equal(r.tz, 'Asia/Tokyo');
    assert.equal(r.offset, -540);
    assert.equal(r.lang, 'ja-JP');
    assert.deepEqual(r.langs, ['ja-JP', 'ja', 'en-US', 'en']);
    assert.equal(r.locale, 'ja-JP');
    assert.equal(r.lat, 35.68);
    assert.equal(r.lon, 139.69);
  });

  test('user agent, client hints and navigator values', async () => {
    const r = await page.evaluate(`
      const he = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'fullVersionList', 'bitness']);
      return { ua: navigator.userAgent, platform: navigator.platform, appVersion: navigator.appVersion, brands: navigator.userAgentData.brands,
               chPlatform: navigator.userAgentData.platform, he, hc: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
               webdriver: navigator.webdriver };`);
    assert.match(r.ua, /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    assert.equal(r.platform, 'MacIntel');
    assert.equal(r.chPlatform, 'macOS');
    assert.equal(r.he.platformVersion, '14.6.1');
    assert.equal(r.he.architecture, 'arm');
    assert.ok(r.brands.some((b) => b.brand === 'Google Chrome'));
    assert.ok(!JSON.stringify(r.brands).includes('Headless'));
    assert.equal(r.hc, 6);
    assert.equal(r.mem, 4);
    assert.equal(r.webdriver, false);
    // the request headers carry the same identity
    const req = target.log.find((l) => l.url === '/page');
    assert.equal(req.headers['user-agent'], r.ua);
    assert.match(req.headers['accept-language'], /^ja-JP/);
    assert.equal(req.headers['sec-ch-ua-platform'], '"macOS"');
  });

  test('screen is spoofed natively (also for media queries) while the viewport stays real', async () => {
    const r = await page.evaluate(`return { w: screen.width, h: screen.height, mq: matchMedia('(device-width: 1600px)').matches, iw: innerWidth,
      avail: [screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight], x: screenX, y: screenY, left: screenLeft, top: screenTop,
      ow: outerWidth, oh: outerHeight, p3: matchMedia('(color-gamut: p3)').matches,
      ts: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(window, 'screenX').get) }`);
    assert.equal(r.w, 1600);
    assert.equal(r.h, 900);
    assert.equal(r.mq, true);
    assert.ok(r.iw > 0);
    // macOS: the menu bar takes the top 25px of the work area
    assert.deepEqual(r.avail, [0, 25, 1600, 875]);
    // the window lies inside the spoofed work area
    assert.ok(r.x >= 0 && r.x + Math.min(r.ow, 1600) <= 1600, `screenX ${r.x}`);
    assert.ok(r.y >= 25, `screenY ${r.y}`);
    assert.equal(r.left, r.x);
    assert.equal(r.top, r.y);
    assert.equal(r.ts, 'function get screenX() { [native code] }');
    assert.equal(r.p3, true); // Mac panels are P3
  });

  test('speech voices match the profile OS and language, not the host', async () => {
    const r = await page.evaluate(`
      const voices = await new Promise((res) => {
        const v = speechSynthesis.getVoices();
        if (v.length) return res(v);
        speechSynthesis.addEventListener('voiceschanged', () => res(speechSynthesis.getVoices()), { once: true });
        setTimeout(() => res(speechSynthesis.getVoices()), 4000);
      });
      const local = voices.filter((v) => v.localService);
      const u = new SpeechSynthesisUtterance('x');
      u.voice = local[0];
      return { local: local.map((v) => v.name + '|' + v.lang), remote: voices.filter((v) => !v.localService).length,
               def: voices.filter((v) => v.default).map((v) => v.name), uri: local[0].voiceURI,
               inst: local[0] instanceof SpeechSynthesisVoice, tag: Object.prototype.toString.call(local[0]), json: JSON.stringify(local[0]),
               same: speechSynthesis.getVoices()[0] === voices[0], uv: u.voice === local[0],
               ts: Function.prototype.toString.call(speechSynthesis.getVoices),
               nameTs: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(SpeechSynthesisVoice.prototype, 'name').get) };`);
    const expected = speechVoices('macos', 'ja-JP');
    assert.deepEqual(r.local, expected.list.map((v) => `${v.name}|${v.lang}`));
    assert.ok(!r.local.some((v) => v.startsWith('Microsoft')));
    assert.ok(r.remote > 0, 'the browser’s own remote voices are kept');
    assert.deepEqual(r.def, ['Kyoko']);
    assert.equal(r.uri, 'Alex');
    assert.equal(r.inst, true);
    assert.equal(r.tag, '[object SpeechSynthesisVoice]');
    assert.equal(r.json, '{}');
    assert.equal(r.same, true);
    assert.equal(r.uv, true);
    assert.equal(r.ts, 'function getVoices() { [native code] }');
    assert.equal(r.nameTs, 'function get name() { [native code] }');
  });

  test('patched functions look native', async () => {
    const r = await page.evaluate(`
      const ts = Function.prototype.toString;
      const g = Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get;
      let illegal = '';
      try { g.call({}); } catch (e) { illegal = e.constructor.name + ': ' + e.message; }
      return { getter: ts.call(g), name: g.name, toDataURL: ts.call(HTMLCanvasElement.prototype.toDataURL),
               toStr: ts.call(ts), toStr2: Function.prototype.toString.toString(), illegal,
               own: Object.getOwnPropertyNames(g).sort().join(','), proto: Object.getPrototypeOf(g) === Function.prototype };`);
    assert.equal(r.getter, 'function get deviceMemory() { [native code] }');
    assert.equal(r.name, 'get deviceMemory');
    assert.equal(r.toDataURL, 'function toDataURL() { [native code] }');
    assert.equal(r.toStr, 'function toString() { [native code] }');
    assert.equal(r.toStr2, 'function toString() { [native code] }');
    assert.equal(r.illegal, 'TypeError: Illegal invocation');
    assert.equal(r.own, 'length,name');
    assert.equal(r.proto, true);
  });

  test('patched functions pass Proxy / stack-trace lie checks (CreepJS style)', async () => {
    const r = await page.evaluate(`
      const g = Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get;
      const out = {};
      for (const [k, f] of [['getter', g], ['method', HTMLCanvasElement.prototype.toDataURL], ['toString', Function.prototype.toString]]) {
        const proto = Object.getPrototypeOf(f);
        try { Object.setPrototypeOf(f, Object.create(f)) + ''; out[k + 'Cycle'] = 'none'; } catch (e) { out[k + 'Cycle'] = e.constructor.name + ': ' + e.message; }
        finally { Object.setPrototypeOf(f, proto); }
        out[k + 'Reflect'] = Reflect.setPrototypeOf(f, Object.create(f));
        Object.setPrototypeOf(f, proto);
        try { new f(); } catch (e) { out[k + 'New'] = e.message; }
      }
      const frames = (fn) => { try { fn(); } catch (e) { return e.stack.split('\\n').slice(1).map((l) => l.trim().split(' (')[0]); } };
      out.getterStack = frames(() => g.call({}));
      out.toStringStack = frames(() => Function.prototype.toString.call({}));
      out.toStringCreate = frames(() => Object.create(g).toString());
      return out;`);
    for (const k of ['getter', 'method', 'toString']) {
      assert.equal(r[`${k}Cycle`], 'TypeError: Cyclic __proto__ value', k); // a Proxy would overflow the stack instead
      assert.equal(r[`${k}Reflect`], false, k);
    }
    assert.equal(r.getterNew, 'f is not a constructor');
    // native code adds no frame: the top frame is the caller (the evaluated page code), never our wrapper
    const caller = /^at <anonymous>:\d+:\d+$/;
    assert.match(r.getterStack[0], caller);
    assert.equal(r.toStringStack[0], 'at Object.toString'); // the builtin frame V8 shows for toString
    assert.match(r.toStringStack[1], caller);
    assert.equal(r.toStringCreate[0], 'at Function.toString');
    assert.match(r.toStringCreate[1], caller);
  });

  test('values written by the page read back exactly (noise traps)', async () => {
    const r = await page.evaluate(`
      // random opaque pixels, read back one by one and as a whole
      const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d');
      const pat = []; let bad = 0;
      for (let i = 0; i < 64; i++) { const col = [i * 3, 255 - i, (i * 37) % 256]; pat.push(col); x.fillStyle = 'rgb(' + col + ')'; x.fillRect(i % 8, i >> 3, 1, 1); }
      const all = x.getImageData(0, 0, 8, 8).data;
      for (let i = 0; i < 64; i++) {
        const p = x.getImageData(i % 8, i >> 3, 1, 1).data;
        for (let k = 0; k < 3; k++) if (p[k] !== pat[i][k] || all[i * 4 + k] !== pat[i][k]) bad++;
      }
      // samples written into an AudioBuffer
      const buf = new AudioBuffer({ length: 64, sampleRate: 44100 });
      const vals = new Float32Array(64).map((_, i) => Math.sin(i) * 0.5);
      buf.copyToChannel(vals, 0);
      const audioBad = vals.filter((v, i) => v !== buf.getChannelData(0)[i]).length;
      // an element with integer geometry
      const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:10px;top:20px;width:100px;height:50px';
      document.body.append(d);
      const rect = d.getBoundingClientRect();
      d.remove();
      return { bad, audioBad, rect: [rect.x, rect.y, rect.width, rect.height] };`);
    assert.equal(r.bad, 0);
    assert.equal(r.audioBad, 0);
    assert.deepEqual(r.rect, [10, 20, 100, 50]);
  });

  test('canvas noise is deterministic, sparse, low-bit and only on anti-aliased pixels', async () => {
    const r = await page.evaluate(`
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(10,20,30)'; x.fillRect(0, 0, 64, 32);          // opaque: must stay exact
      x.fillStyle = 'rgba(200,100,50,0.5)'; x.fillRect(0, 32, 64, 32);  // semi-transparent: gets noise
      const d = x.getImageData(0, 0, 64, 64).data;
      let opaqueChanged = 0, changed = 0, maxDiff = 0;
      const ref = [d[64 * 40 * 4], d[64 * 40 * 4 + 1], d[64 * 40 * 4 + 2]];
      const counts = new Map();
      for (let i = 64 * 32 * 4; i < d.length; i += 4) { const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
      const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      for (let i = 0; i < d.length; i += 4) {
        if (i < 64 * 32 * 4) { if (d[i] !== 10 || d[i + 1] !== 20 || d[i + 2] !== 30) opaqueChanged++; continue; }
        const diff = Math.max(Math.abs(d[i] - mode[0]), Math.abs(d[i + 1] - mode[1]), Math.abs(d[i + 2] - mode[2]));
        if (diff) changed++; maxDiff = Math.max(maxDiff, diff);
      }
      const sub = x.getImageData(5, 37, 10, 10).data, full = x.getImageData(0, 0, 64, 64).data;
      let consistent = true;
      for (let yy = 0; yy < 10; yy++) for (let xx = 0; xx < 10; xx++) for (let k = 0; k < 4; k++)
        if (sub[(yy * 10 + xx) * 4 + k] !== full[((yy + 37) * 64 + xx + 5) * 4 + k]) consistent = false;
      return { opaqueChanged, changed, maxDiff, consistent, a: c.toDataURL(), b: c.toDataURL() };`);
    assert.equal(r.opaqueChanged, 0);
    assert.ok(r.changed > 10 && r.changed < 200, `changed pixels: ${r.changed}`);
    assert.equal(r.maxDiff, 1);
    assert.ok(r.consistent);
    assert.equal(r.a, r.b);
  });

  test('WebGL vendor / renderer', async (t) => {
    const r = await page.evaluate(`
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { v: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), r: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), plain: gl.getParameter(gl.VENDOR) };`);
    if (!r) return t.skip('no WebGL in this headless environment');
    assert.equal(r.v, 'Google Inc. (Apple)');
    assert.equal(r.r, MAC_RENDERER);
    assert.equal(r.plain, 'WebKit');
  });

  test('audio noise is stable across renders', async () => {
    const r = await page.evaluate(`
      const render = async () => {
        const ctx = new OfflineAudioContext(1, 44100, 44100);
        const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor(); osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
        const buf = await ctx.startRendering();
        const data = buf.getChannelData(0); let sum = 0;
        for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        const copy = new Float32Array(100); buf.copyFromChannel(copy, 0, 4500);
        return { sum, copyOk: copy.every((v, i) => v === data[4500 + i]) };
      };
      return [await render(), await render()];`);
    assert.equal(r[0].sum, r[1].sum);
    assert.ok(r[0].copyOk);
  });

  test('about:blank and srcdoc frames are patched too', async () => {
    const r = await page.evaluate(`
      const f = document.createElement('iframe'); document.body.appendChild(f);
      const viaIndex = window[0].navigator.deviceMemory;
      const viaContent = f.contentWindow.navigator.deviceMemory;
      const ts = window[0].Function.prototype.toString.call(Object.getOwnPropertyDescriptor(window[0].Navigator.prototype, 'deviceMemory').get);
      const f2 = document.createElement('iframe'); f2.srcdoc = '<p>x</p>'; document.body.appendChild(f2);
      await new Promise(r => f2.onload = r);
      const w2 = f2.contentWindow;
      const c = w2.document.createElement('canvas'); c.width = 32; c.height = 32;
      const x = c.getContext('2d'); x.fillStyle = 'rgba(200,100,50,0.5)'; x.fillRect(0, 0, 32, 32);
      const d = x.getImageData(0, 0, 32, 32).data; let changed = 0;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      changed = seen.size - 1; // a uniform fill has one colour; noise adds variants
      document.body.insertAdjacentHTML('beforeend', '<iframe id="h"></iframe>');
      const viaHtml = window[window.length - 1].navigator.deviceMemory;
      return { viaIndex, viaContent, ts, srcdocMem: w2.navigator.deviceMemory, srcdocHc: w2.navigator.hardwareConcurrency, changed,
               srcdocScreen: w2.screen.width, viaHtml };`);
    assert.equal(r.viaIndex, 4);
    assert.equal(r.viaContent, 4);
    assert.equal(r.ts, 'function get deviceMemory() { [native code] }');
    assert.equal(r.srcdocMem, 4);
    assert.equal(r.srcdocHc, 6);
    assert.equal(r.srcdocScreen, 1600);
    assert.ok(r.changed > 0);
    assert.equal(r.viaHtml, 4);
  });

  test('dedicated workers see the same identity', async () => {
    const r = await page.evaluate(`
      return await new Promise((res) => { const w = new Worker('/worker.js'); w.onmessage = (e) => res(e.data); });`);
    assert.equal(r.hc, 6);
    assert.match(r.ua, /Macintosh/);
    assert.equal(r.platform, 'MacIntel');
    assert.equal(r.tz, 'Asia/Tokyo');
    assert.deepEqual(r.langs, ['ja-JP', 'ja', 'en-US', 'en']);
    assert.equal(r.ts, 'function get hardwareConcurrency() { [native code] }');
  });

  test('shared and service workers see the same identity as the page', async () => {
    const r = await page.evaluate(`
      const shared = await new Promise((res) => { const w = new SharedWorker('/shared.js'); w.port.onmessage = (e) => res(e.data); setTimeout(() => res(null), 5000); });
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sw = reg.active || reg.waiting || reg.installing;
      const service = await new Promise((res) => { navigator.serviceWorker.onmessage = (e) => res(e.data); sw.postMessage('probe'); setTimeout(() => res(null), 5000); });
      await reg.unregister();
      return { shared, service };`);
    for (const scope of ['shared', 'service']) {
      const v = r[scope];
      assert.ok(v, `${scope} worker did not answer`);
      assert.equal(v.tz, 'Asia/Tokyo', scope);
      assert.deepEqual(v.langs, ['ja-JP', 'ja', 'en-US', 'en'], scope);
      assert.equal(v.hc, 6, scope);
      assert.equal(v.mem, 4, scope);
      assert.match(v.ua, /Macintosh/, scope);
      assert.equal(v.platform, 'MacIntel', scope);
    }
  });

  test('WebRTC gathers no local candidates', async () => {
    const r = await page.evaluate(`
      const pc = new RTCPeerConnection({ iceServers: [] });
      const cands = [];
      pc.onicecandidate = (e) => e.candidate && cands.push(e.candidate.candidate);
      pc.createDataChannel('x');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(r => setTimeout(r, 1500));
      pc.close();
      return cands;`);
    assert.deepEqual(r, []);
  });

  test('traffic to the outside goes through the upstream proxy', async () => {
    const before = socks.log.length;
    const p2 = await openPage(info.ws, 'http://target.test/through-proxy');
    try {
      const body = await p2.evaluate('return document.body.textContent');
      assert.match(body, /via-proxy/);
      assert.ok(socks.log.slice(before).some((l) => l.host === 'target.test'));
      const req = target.log.find((l) => l.url === '/through-proxy');
      assert.match(req.headers['user-agent'], /Macintosh/);
    } finally {
      await p2.close();
    }
  });

  test('popups opened by a page get the fingerprint before running', async () => {
    const r = await page.evaluate(`
      const w = window.open('/popup');
      await new Promise(r => setTimeout(r, 1500));
      const out = { mem: w.navigator.deviceMemory, hc: w.navigator.hardwareConcurrency, tz: w.Intl.DateTimeFormat().resolvedOptions().timeZone, href: w.location.pathname };
      w.close();
      return out;`);
    assert.deepEqual(r, { mem: 4, hc: 6, tz: 'Asia/Tokyo', href: '/popup' });
    assert.equal(target.log.find((l) => l.url === '/popup').headers['sec-ch-ua-platform'], '"macOS"');
  });

  test('target=_blank (noopener) links open patched tabs', async () => {
    await page.evaluate(`const a = document.createElement('a'); a.href = '/linked'; a.target = '_blank'; document.body.append(a); a.click(); return 1`);
    let t;
    for (let i = 0; i < 50 && !t; i++) {
      await sleep(100);
      t = (await page.conn.send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && x.url.endsWith('/linked'));
    }
    assert.ok(t, 'linked tab did not load');
    const p2 = await openPage(info.ws, t.url, t.targetId);
    try {
      const r = await p2.evaluate(`return { mem: navigator.deviceMemory, hc: navigator.hardwareConcurrency, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, opener: window.opener }`);
      assert.deepEqual(r, { mem: 4, hc: 6, tz: 'Asia/Tokyo', opener: null });
      const req = target.log.find((l) => l.url === '/linked');
      assert.equal(req.headers['sec-ch-ua-platform'], '"macOS"');
      assert.match(req.headers['user-agent'], /Macintosh/);
    } finally {
      await p2.close();
    }
  });

  test('collect a fingerprint sample for the comparison with an unmodified Chrome', async () => {
    profileSample = await page.evaluate(FP_SAMPLE);
    assert.ok(profileSample.canvas.startsWith('data:image/png'));
  });

  test('cookies persist and can be exported / imported while stopped', async () => {
    await page.evaluate(`document.cookie = 'sid=abc123; max-age=86400; path=/'; return 1`);
    const live = await app.launcher.getCookies(profile.id);
    assert.ok(live.some((c) => c.name === 'sid' && c.value === 'abc123'));
    await page.close();
    page = null;
    await app.launcher.stop(profile.id);
    assert.equal(app.launcher.status(profile.id), 'stopped');
    const stored = await app.launcher.getCookies(profile.id); // temporary headless browser
    assert.ok(stored.some((c) => c.name === 'sid' && c.value === 'abc123'));
    const res = await app.launcher.importCookies(profile.id, [{ domain: '127.0.0.1', name: 'imported', value: 'yes', path: '/', hostOnly: true, session: false, expirationDate: Date.now() / 1000 + 3600, sameSite: 'lax' }]);
    assert.equal(res.queued, 1);
    info = await app.launcher.start(profile.id, { headless: true });
    const after = await app.launcher.getCookies(profile.id);
    assert.ok(after.some((c) => c.name === 'imported' && c.value === 'yes'));
    assert.equal(app.store.getProfile(profile.id).pendingCookies.length, 0);
  });

  test('AdsPower-compatible local API', async () => {
    const base = app.baseUrl;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.deepEqual(await get('/status'), { code: 0, msg: 'success' });
    const active = await get(`/api/v1/browser/active?user_id=${profile.id}`);
    assert.equal(active.data.status, 'Active');
    assert.equal(active.data.ws.puppeteer, info.ws);
    const list = await get('/api/v1/user/list?page_size=10');
    assert.ok(list.data.list.some((u) => u.user_id === profile.id && u.ip === '203.0.113.7'));
    const created = await post('/api/v1/user/create', {
      name: 'api-made',
      group_id: '0',
      user_proxy_config: { proxy_soft: 'other', proxy_type: 'http', proxy_host: '10.0.0.1', proxy_port: '8080', proxy_user: 'a', proxy_password: 'b' },
      fingerprint_config: { automatic_timezone: '0', timezone: 'Europe/Berlin', language: ['de-DE', 'de'], screen_resolution: '1920_1080', hardware_concurrency: '8', webrtc: 'disabled' },
    });
    assert.equal(created.code, 0);
    const p = app.store.getProfile(created.data.id);
    assert.equal(p.proxy.host, '10.0.0.1');
    assert.equal(p.fingerprint.timezone.value, 'Europe/Berlin');
    assert.equal(p.fingerprint.language.value, 'de-DE,de');
    assert.equal(p.fingerprint.screen.width, 1920);
    assert.equal(p.fingerprint.webrtc, 'disabled');
    assert.equal((await post('/api/v1/user/delete', { user_ids: [created.data.id] })).code, 0);
    assert.equal(app.store.getProfile(created.data.id), null);
    // cross-site browser requests are refused
    const forged = await fetch(`${base}/api/v1/browser/stop?user_id=${profile.id}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(forged.status, 403);
    const stop = await get(`/api/v1/browser/stop?user_id=${profile.id}`);
    assert.equal(stop.code, 0);
    assert.equal((await get(`/api/v1/browser/active?user_id=${profile.id}`)).data.status, 'Inactive');
  });
});

describe('compared with an unmodified Chrome', { skip: !chrome && 'Chrome not installed', timeout: 60000 }, () => {
  let dir, target, proc, page;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-clean-'));
    target = await startTargetServer();
    proc = spawn(chrome.path, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    let port, wsPath;
    for (let i = 0; i < 200 && !port; i++) {
      try {
        [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      } catch {
        await sleep(100);
      }
    }
    page = await openPage(`ws://127.0.0.1:${port}${wsPath}`, `http://127.0.0.1:${target.port}/`);
  });

  after(async () => {
    await page?.conn.send('Browser.close').catch(() => {});
    page?.conn.close();
    proc?.kill();
    await target?.close();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('client hints brand list matches what Chrome itself reports', async () => {
    const r = await page.evaluate(`const h = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']); return { brands: navigator.userAgentData.brands, full: h.fullVersionList }`);
    const version = await page.conn.send('Browser.getVersion');
    const full = version.product.split('/')[1];
    const major = Number(full.split('.')[0]);
    const expected = brandLists(major, 'chrome', full);
    // headless reports "HeadlessChrome" where branded Chrome says "Google Chrome"
    const norm = (list) => list.map((b) => ({ ...b, brand: b.brand.replace('HeadlessChrome', 'Google Chrome') }));
    assert.deepEqual(norm(r.brands), expected.brands);
    assert.deepEqual(norm(r.full), expected.fullVersionList);
  });

  test('canvas, audio and text-rect fingerprints differ from the unmodified browser', async (t) => {
    if (!profileSample) return t.skip('profile sample not collected');
    const clean = await page.evaluate(FP_SAMPLE);
    assert.notEqual(profileSample.canvas, clean.canvas, 'canvas');
    assert.notEqual(profileSample.audio, clean.audio, 'audio');
    if (clean.width % 1 !== 0) assert.notEqual(profileSample.width, clean.width, 'text rect');
    // but only slightly
    assert.ok(Math.abs(profileSample.audio - clean.audio) < 1e-3);
    assert.ok(Math.abs(profileSample.width - clean.width) < 0.01);
  });
});
