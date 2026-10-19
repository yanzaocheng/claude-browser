/**
 * AdsPower SunBrowser kernel adapter.
 *
 * The kernel (sunbrowser.exe) takes its fingerprint from three obfuscated files plus one
 * command-line blob instead of CDP overrides:
 *
 *   <profile>/<static>   canvas / webgl marks, CPU, memory, langs, UA metadata, paths
 *   <profile>/<dynamic>  TimeZone + Geoposition (+ block lists)
 *   <profile>/<webglfp>  {"UNMASKED_VENDOR_WEBGL": ...}
 *   --extended-parameters=<blob>  the same numbers again, consumed at browser start
 *
 * All four use the same "594…" cipher recovered from AdsPower's local service:
 *   decode: each char -> its index in C2 -> the char at that index in C1 -> standard base64
 *   encode: the exact reverse
 *
 * This module rewrites those files per profile so every environment gets its own timezone,
 * geolocation, canvas/webgl marks, CPU/memory and languages, then builds the launch args.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.join(HERE, '..', 'assets', 'sunbrowser');
const SEED_DIR = path.join(ASSETS_DIR, 'seed');

const C1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * AdsPower names the per-profile files after the profile id:
 *   static  -> md5("<id>_static"),  webgl -> md5("<id>_webgl") + "_Other" / "_Android",
 *   cookies -> md5("<id>_cookies").  The kernel looks them up by that name, so a profile that
 *   keeps the seed's names silently falls back to the host GPU.
 */
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Windows only reports 10.0.0 (Win10) or 13/14/15.0.0 (Win11 releases) in UA-CH; anything else
// is a tell ("19.0.0" does not exist)
const WIN_PLATFORM_VERSIONS = ['10.0.0', '13.0.0', '14.0.0', '15.0.0'];
export function sanePlatformVersion(v) {
  const s = String(v || '');
  return WIN_PLATFORM_VERSIONS.includes(s) ? s : '15.0.0';
}
export function profileFileNames(id) {
  return {
    static: md5(`${id}_static`),
    dynamic: md5(`${id}_dynamic`),
    cookies: md5(`${id}_cookies`),
    webglBase: md5(`${id}_webgl`),
    icon: `${md5(`${id}_icon`)}.ico`,
  };
}
const C2 = 'hTy1bfRJz4nLPcBCO7WtmNIaGvVeul5Zo8kq32UxrYw_-0gsjp96SDFXQiEMKdHA';

/** Encrypted AdsPower config -> plain JSON text. */
export function decodeCfg(text) {
  let b64 = '';
  for (const ch of String(text).trim()) {
    const i = C2.indexOf(ch);
    b64 += i < 0 ? ch : C1[i];
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Plain JSON text -> encrypted AdsPower config. */
export function encodeCfg(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  let out = '';
  for (const ch of b64) {
    const i = C1.indexOf(ch);
    out += i < 0 ? ch : C2[i];
  }
  return out;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function seedFiles() {
  const files = fs.existsSync(SEED_DIR) ? fs.readdirSync(SEED_DIR) : [];
  const out = {};
  for (const name of files) {
    const full = path.join(SEED_DIR, name);
    const raw = fs.readFileSync(full, 'utf8');
    if (raw.trim().startsWith('[{"name":"BROWSER_ID"')) out.cookies = name;
    else if (raw.trim().startsWith('{"UNMASKED_VENDOR_WEBGL"')) (out.webgl ||= []).push(name);
    else if (/^594/.test(raw.trim())) {
      try {
        const o = JSON.parse(decodeCfg(raw));
        if (o.TimeZone !== undefined) out.dynamic = name;
        else if (o.CanvasMark !== undefined || o.UserAgentMetadata !== undefined) out.static = name;
      } catch {}
    } else if (name.endsWith('.ico')) out.icon = name;
  }
  return out;
}

const cmpVersion = (a = '', b = '') => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

/** Finds sunbrowser.exe: explicit path, then the AdsPower client's kernel folders. */
export function findSunBrowser(explicitPath = '') {
  if (process.platform !== 'win32') return null;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return { path: explicitPath, version: kernelVersion(path.dirname(explicitPath)) };
  }
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'adspower_global', 'cwd_global'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'adspower_global', 'cwd_global'));
  const found = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!/^chrome_\d+$/.test(d)) continue;
      const exe = path.join(root, d, 'sunbrowser.exe');
      if (!fs.existsSync(exe)) continue;
      found.push({ path: exe, version: kernelVersion(path.dirname(exe)) });
    }
  }
  found.sort((a, b) => cmpVersion(a.version, b.version));
  return found.at(-1) || null;
}

function kernelVersion(dir) {
  try {
    const v = fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort(cmpVersion);
    return v.at(-1) || '153.0.0.0';
  } catch {
    return '153.0.0.0';
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANGS_FALLBACK = ['en-US', 'en'];

function languageArgs(rt) {
  const langs = Array.isArray(rt.languages) && rt.languages.length ? rt.languages : LANGS_FALLBACK;
  const primary = langs[0];
  const base = primary.split('-')[0];
  // the kernel expects AdsPower's two-entry form ("en-US,en"); longer lists make it drop the config
  return { langs: `${primary},${base}`, acceptLang: `${primary},${base};q=0.9` };
}

function geoString(rt) {
  const g = rt.geolocation;
  if (!g || !Number.isFinite(g.latitude) || !Number.isFinite(g.longitude)) return null;
  return `${Number(g.latitude).toFixed(4)},${Number(g.longitude).toFixed(4)},${Math.round(g.accuracy || 1000)}`;
}

function replacePaths(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => replacePaths(v, from, to));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = replacePaths(value[k], from, to);
    return value;
  }
  return value;
}

/**
 * Writes kernel config files into the profile directory and returns the numbers used, so the
 * command line and the files always agree.
 */
export function prepareSunBrowserProfile(userDataDir, { rt, profile, webrtcPolicy = '' }) {
  const meta = readJson(path.join(ASSETS_DIR, 'tpl_meta.json')) || {};
  const seed = seedFiles();
  if (!seed.static || !seed.dynamic) throw new Error('SunBrowser 种子配置缺失（assets/sunbrowser/seed）');
  fs.mkdirSync(userDataDir, { recursive: true });

  const srcDir = meta.srcDir || '';
  const srcName = meta.srcName || '';
  const id = profile.id;
  const names = profileFileNames(id);
  const paths = {
    static: path.join(userDataDir, names.static),
    dynamic: path.join(userDataDir, names.dynamic),
    cookies: path.join(userDataDir, names.cookies),
    webglOther: path.join(userDataDir, `${names.webglBase}_Other`),
    webglAndroid: path.join(userDataDir, `${names.webglBase}_Android`),
    icon: path.join(userDataDir, names.icon),
  };
  const rnd = mulberry32((profile.fingerprint?.seed ?? Date.now()) >>> 0);
  const mark = () => String(1000 + Math.floor(rnd() * 98000));

  const lang = languageArgs(rt);
  const timezone = rt.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const geo = geoString(rt);
  const canvasMark = profile.fingerprint?.canvas === 'noise' ? mark() : '0';
  const webglMark = profile.fingerprint?.webglImage === 'noise' ? mark() : '0';
  const hardwareConcurrency = rt.hardwareConcurrency || 8;
  const deviceMemory = rt.deviceMemory || 8;
  const startTime = Math.floor(Date.now() / 1000);
  const userId = String((profile.serial || 1) * 1000 + (rnd() * 900 | 0));

  // ---- static config
  const staticCfg = JSON.parse(decodeCfg(fs.readFileSync(path.join(SEED_DIR, seed.static), 'utf8')));
  staticCfg.CanvasMark = canvasMark;
  staticCfg.CanvasMarkEx = canvasMark;
  staticCfg.WebGLMark = webglMark;
  staticCfg.WebGLMarkEx = webglMark;
  staticCfg.UserId = userId;
  staticCfg.StartTime = startTime;
  staticCfg.HardwareConcurrency = hardwareConcurrency;
  staticCfg.DeviceMemory = deviceMemory;
  staticCfg.Langs = lang.langs;
  staticCfg.AcceptLang = lang.acceptLang;
  staticCfg.Platform = 'Win32';
  // WebRTC policy also lives in the config's command_line block, not only on argv
  if (webrtcPolicy) {
    staticCfg.command_line = staticCfg.command_line || {};
    staticCfg.command_line['webrtc-ip-handling-policy'] = webrtcPolicy;
  }
  // the seed profile is an Android handset; a Windows desktop UA must not carry a phone model
  staticCfg.ProductType = '';
  staticCfg.DeviceName = '';
  staticCfg.MaxTouchPoints = 0;
  staticCfg.UserAgentMetadata = {
    ...(staticCfg.UserAgentMetadata || {}),
    platform: 'Windows',
    platformVersion: sanePlatformVersion(rt.platformVersion),
    architecture: 'x86',
    bitness: '64',
    wow64: false,
    mobile: false,
    model: '',
  };
  if (rt.screen) {
    staticCfg.ScreenWidth = rt.screen.width;
    staticCfg.ScreenHeight = rt.screen.height;
  }
  replacePaths(staticCfg, srcDir, userDataDir);
  replacePaths(staticCfg, srcName, id);
  if (Array.isArray(staticCfg.ExtensionSetting)) {
    staticCfg.ExtensionSetting = staticCfg.ExtensionSetting.filter((e) => !e?.path || fs.existsSync(e.path));
  }
  fs.writeFileSync(paths.static, encodeCfg(JSON.stringify(staticCfg)), 'utf8');

  // ---- dynamic config: timezone + geolocation
  const dynamicCfg = JSON.parse(decodeCfg(fs.readFileSync(path.join(SEED_DIR, seed.dynamic), 'utf8')));
  dynamicCfg.TimeZone = timezone;
  if (geo) dynamicCfg.Geoposition = geo;
  fs.writeFileSync(paths.dynamic, encodeCfg(JSON.stringify(dynamicCfg)), 'utf8');

  // ---- webgl vendor/renderer: desktop `_Other` and the android variant are separate files
  for (const name of seed.webgl || []) {
    const file = name.endsWith('_Android') ? paths.webglAndroid : paths.webglOther;
    const source = readJson(path.join(SEED_DIR, name)) || readJson(file) || {};
    const webgl = { ...source };
    if (rt.spoof?.webgl) {
      webgl.UNMASKED_VENDOR_WEBGL = rt.spoof.webgl.vendor;
      webgl.UNMASKED_RENDERER_WEBGL = rt.spoof.webgl.renderer;
    }
    webgl.SUPPORTED_EXTENSIONS = webgl.SUPPORTED_EXTENSIONS || [];
    fs.writeFileSync(file, JSON.stringify(webgl), 'utf8');
  }
  if (seed.icon) fs.copyFileSync(path.join(SEED_DIR, seed.icon), paths.icon);

  // ---- cookies file: fresh BROWSER_ID per profile
  if (seed.cookies) {
    const file = paths.cookies;
    const cookies = readJson(path.join(SEED_DIR, seed.cookies)) || [];
    for (const c of cookies) if (c.name === 'BROWSER_ID') c.value = id;
    fs.writeFileSync(file, JSON.stringify(cookies), 'utf8');
  }

  // ---- extended parameters blob (what the browser process actually broadcasts)
  const ext = JSON.parse(decodeCfg(meta.extBlob || ''));
  ext.UserId = userId;
  ext.CanvasMark = canvasMark;
  ext.WebGLMark = webglMark;
  ext.StartTime = startTime;
  ext.HardwareConcurrency = hardwareConcurrency;
  ext.DeviceMemory = deviceMemory;
  const seedBaseByRole = {
    static: seed.static,
    dynamic: seed.dynamic,
    cookies: seed.cookies,
    webglOther: (seed.webgl || []).find((n) => n.endsWith('_Other')) || '',
    icon: seed.icon || '',
  };
  for (const k of Object.keys(ext)) {
    if (typeof ext[k] !== 'string') continue;
    if (srcDir && ext[k].includes(srcDir)) ext[k] = ext[k].split(srcDir).join(userDataDir);
    else if (srcName && ext[k].includes(srcName)) ext[k] = ext[k].split(srcName).join(id);
    const base = path.basename(ext[k]);
    for (const [role, seedName] of Object.entries(seedBaseByRole)) {
      if (seedName && base === seedName) ext[k] = paths[role];
    }
  }

  // drop seed-named leftovers so the kernel cannot pick the old files up
  for (const legacy of [seed.static, seed.dynamic, seed.cookies, seed.icon, ...(seed.webgl || [])]) {
    if (!legacy) continue;
    const p = path.join(userDataDir, legacy);
    if (fs.existsSync(p) && !Object.values(paths).includes(p)) fs.rmSync(p, { force: true });
  }

  return {
    seed,
    paths,
    numbers: { userId, canvasMark, webglMark, hardwareConcurrency, deviceMemory, startTime, timezone, geo, langs: lang.langs, acceptLang: lang.acceptLang },
    extBlob: encodeCfg(JSON.stringify(ext)),
  };
}

/** Splits a template command line into argv tokens, honouring double quotes. */
function tokenize(text) {
  const normalized = String(text).replace(/"--([A-Za-z0-9-]+)=/g, '--$1="');
  const out = [];
  const re = /--[A-Za-z0-9-]+(=(?:"[^"]*"|[^\s"]*))?/g;
  let m;
  while ((m = re.exec(normalized))) {
    let token = m[0];
    const eq = token.indexOf('=');
    if (eq > 0) {
      let value = token.slice(eq + 1);
      // argv values must not keep the shell quotes: the kernel would treat them literally
      if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
      token = token.slice(0, eq + 1) + value;
    }
    out.push(token);
  }
  return out;
}

/** Builds the kernel argv for one profile. */
export function buildSunBrowserArgs({ userDataDir, profile, rt, prepared, proxyArg, webrtcPolicy = '', extraArgs = [] }) {
  const meta = readJson(path.join(ASSETS_DIR, 'tpl_meta.json')) || {};
  const browserTpl = fs.readFileSync(path.join(ASSETS_DIR, 'tpl_browser.txt'), 'utf8');
  const protectedTpl = fs.readFileSync(path.join(ASSETS_DIR, 'tpl_protected.txt'), 'utf8');
  const srcDir = meta.srcDir || '';
  const srcName = meta.srcName || '';

  const n = prepared.numbers;
  const overrides = new Map(Object.entries({
    '--user-data-dir=': `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=': '--remote-debugging-port=0',
    '--protected-userid=': `--protected-userid=${n.userId}`,
    '--protected-geoposition=': `--protected-geoposition=${n.geo || '0,0,1000'}`,
    '--protected-timezone=': `--protected-timezone=${n.timezone}`,
    '--protected-canvasmark=': `--protected-canvasmark=${n.canvasMark}`,
    '--protected-webglmark=': `--protected-webglmark=${n.webglMark}`,
    '--protected-hardwareconcurrency=': `--protected-hardwareconcurrency=${n.hardwareConcurrency}`,
    '--protected-devicememory=': `--protected-devicememory=${n.deviceMemory}`,
    '--protected-langs=': `--protected-langs=${n.langs}`,
    '--protected-acceptlang=': `--protected-acceptlang=${n.acceptLang}`,
    '--protected-starttime=': `--protected-starttime=${n.startTime}`,
    '--extended-parameters=': `--extended-parameters=${prepared.extBlob}`,
    '--lang=': `--lang=${String(n.langs).split(',')[0]}`,
  }));
  if (prepared.paths) {
    overrides.set('--protected-staticconfig=', `--protected-staticconfig=${prepared.paths.static}`);
    overrides.set('--protected-dynamicconfig=', `--protected-dynamicconfig=${prepared.paths.dynamic}`);
    overrides.set('--protected-webglfp=', `--protected-webglfp=${prepared.paths.webglOther}`);
    overrides.set('--protected-cookiesfile=', `--protected-cookiesfile=${prepared.paths.cookies}`);
    overrides.set('--protected-customicon=', `--protected-customicon=${prepared.paths.icon}`);
  }
  if (rt.userAgent) overrides.set('--user-agent=', `--user-agent=${rt.userAgent}`);

  const tokens = [...tokenize(browserTpl), ...tokenize(protectedTpl)].map((t) => t.split(srcDir).join(userDataDir).split(srcName).join(profile.id));
  const args = [];
  const used = new Set();
  for (const t of tokens) {
    let replaced = false;
    for (const [k, v] of overrides) {
      if (t.startsWith(k)) {
        args.push(v);
        used.add(k);
        replaced = true;
        break;
      }
    }
    if (!replaced) args.push(t);
  }
  // keys the template did not contain
  for (const [k, v] of overrides) if (k !== '--extended-parameters=' && !used.has(k)) args.push(v);

  if (webrtcPolicy === 'default') {
    // the kernel defaults to a restrictive policy; be explicit so srflx candidates appear at all
    const at = args.findIndex((a) => a.startsWith('--webrtc-ip-handling-policy'));
    const token = '--webrtc-ip-handling-policy=default';
    if (at >= 0) args[at] = token;
    else args.push(token);
  } else if (webrtcPolicy) {
    const at = args.findIndex((a) => a.startsWith('--webrtc-ip-handling-policy'));
    const token = `--webrtc-ip-handling-policy=${webrtcPolicy}`;
    if (at >= 0) args[at] = token;
    else args.push(token);
  }
  if (proxyArg) args.push(`--proxy-server=${proxyArg}`);
  if (rt.screen && !args.some((a) => a.startsWith('--window-size='))) {
    args.push(`--window-size=${Math.round(rt.screen.width * 0.8)},${Math.round(rt.screen.height * 0.8)}`);
  }
  for (const a of extraArgs) {
    if (typeof a === 'string' && a.startsWith('--') && !a.startsWith('--user-data-dir') && !a.startsWith('--remote-debugging')) args.push(a);
  }
  if (!args.includes('about:blank')) args.push('about:blank');
  return args;
}

/**
 * Stand-in for FingerprintController when the kernel does the spoofing itself: same surface
 * (fullVersion / init / openTabs) but no CDP overrides — those would fight the native ones.
 */
export class SunBrowserController {
  constructor(conn, rt, browser, { log, uaOverride, langs, screen } = {}) {
    this.conn = conn;
    this.rt = rt;
    this.browser = browser;
    this.log = log || (() => {});
    this.fullVersion = browser.version || '';
    // must equal what the kernel config says, otherwise main thread and workers disagree
    this.langs = langs || (rt.languages || []).slice(0, 2).join(',') || 'en-US,en';
    this.screen = screen || null;
    // the kernel is a Chromium build, so its own UA-CH brands read "Chromium, Not A(Brand" —
    // a Google Chrome profile must advertise the Chrome brand list instead
    this.uaOverride = uaOverride || null;
    this.applied = new Set();
  }

  async init() {
    try {
      const v = await this.conn.send('Browser.getVersion');
      this.fullVersion = v.product.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || this.fullVersion;
      this.userAgent = v.userAgent;
    } catch (e) {
      this.log(`getVersion: ${e.message}`);
    }
    if (!this.uaOverride) return;
    this.conn.on('attached', (session, params) => {
      const type = params?.targetInfo?.type;
      if (!['page', 'iframe', 'worker', 'shared_worker'].includes(type)) return;
      this.applyUA(session, type).catch((e) => this.log(`ua override ${type}: ${e.message}`));
    });
    try {
      await this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const { targetInfos } = await this.conn.send('Target.getTargets');
      for (const t of targetInfos) {
        if (t.type !== 'page') continue;
        try {
          const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          const s = this.conn.session(sessionId);
          if (s) await this.applyUA(s, 'page');
        } catch {}
      }
    } catch (e) {
      this.log(`setAutoAttach: ${e.message}`);
    }
  }

  async applyUA(session, type) {
    const o = this.uaOverride;
    if (o) {
      const params = {
        userAgent: o.userAgent,
        acceptLanguage: this.langs,
        platform: o.platform,
        userAgentMetadata: o.userAgentMetadata,
      };
      try {
        await session.send('Network.setUserAgentOverride', params);
      } catch {}
      try {
        await session.send('Emulation.setUserAgentOverride', params);
      } catch (e) {
        if (type !== 'worker' && type !== 'shared_worker') this.log(`Emulation.setUserAgentOverride: ${e.message}`);
      }
    }
    if (type === 'page' || type === 'iframe') {
      // the kernel itself does not spoof the screen: report the profile's resolution, keep the viewport
      if (this.screen) {
        try {
          await session.send('Emulation.setDeviceMetricsOverride', {
            width: 0,
            height: 0,
            deviceScaleFactor: 0,
            mobile: false,
            screenWidth: this.screen.width,
            screenHeight: this.screen.height,
          });
        } catch (e) {
          this.log(`setDeviceMetricsOverride: ${e.message}`);
        }
      }
      if (this.rt.colorGamut) {
        try {
          await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'color-gamut', value: this.rt.colorGamut }] });
        } catch {}
      }
    }
    this.applied.add(session.id);
  }

  async openTabs(urls) {
    const list = (urls || []).filter(Boolean);
    let targets = [];
    try {
      ({ targetInfos: targets } = await this.conn.send('Target.getTargets'));
    } catch {}
    const pages = targets.filter((t) => t.type === 'page');
    if (!list.length) return;
    const first = pages.find((t) => !t.url || t.url === 'about:blank') || pages[0];
    const navigate = async (targetId, url) => {
      if (!url || url === 'about:blank') return;
      try {
        const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
        await this.conn.send('Page.navigate', { url }, sessionId);
      } catch (e) {
        this.log(`navigate ${url}: ${e.message}`);
      }
    };
    if (first) {
      await navigate(first.targetId, list[0]);
      for (const url of list.slice(1)) {
        try {
          const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', background: true });
          await navigate(targetId, url);
        } catch {}
      }
      return;
    }
    for (const url of list) {
      try {
        const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', background: false });
        await navigate(targetId, url);
      } catch {}
    }
  }
}
