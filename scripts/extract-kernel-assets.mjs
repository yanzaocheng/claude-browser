/**
 * Rebuilds `assets/sunbrowser/seed/` + `tpl_meta.json` from a local AdsPower installation.
 *
 * The seed files are AdsPower's own per-profile config blobs, so they are not checked in.
 * Run this once after cloning (and again if you want a different fingerprint baseline):
 *
 *   node scripts/extract-kernel-assets.mjs                 # auto-detect a profile
 *   node scripts/extract-kernel-assets.mjs --profile "C:\.ADSPOWER_GLOBAL\cache\k1i3wjtr_i7ji9k"
 *
 * What it produces:
 *   assets/sunbrowser/seed/        staticconfig / dynamicconfig / cookies / webgl / icon
 *   assets/sunbrowser/tpl_meta.json  {srcDir, srcName, extBlob}
 *
 * `extBlob` is rebuilt from the seed's own static/dynamic config (same keys the kernel
 * broadcasts at startup), so no live process is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCfg, encodeCfg, profileFileNames } from '../src/kernel-sunbrowser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets', 'sunbrowser');
const SEED = path.join(ASSETS, 'seed');
const args = process.argv.slice(2);
const opt = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const CACHE_ROOTS = [
  'C:\\.ADSPOWER_GLOBAL\\cache',
  path.join(process.env.USERPROFILE || '', '.ADSPOWER_GLOBAL', 'cache'),
  path.join(process.env.APPDATA || '', 'adspower_global', 'cwd_global', 'source', 'cache'),
];

/** A kernel profile directory contains 32-hex config files (static/dynamic/cookies/webgl). */
function looksLikeProfile(dir) {
  try {
    const files = fs.readdirSync(dir);
    return files.some((f) => /^[0-9a-f]{32}$/.test(f));
  } catch {
    return false;
  }
}

function findProfile() {
  const explicit = opt('profile');
  if (explicit) return explicit;
  for (const root of CACHE_ROOTS) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const full = path.join(root, d.name);
      if (looksLikeProfile(full)) return full;
    }
  }
  return '';
}

function classify(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > 200000) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim().startsWith('[{"name":"BROWSER_ID"')) {
      out.cookies = name;
      continue;
    }
    if (raw.trim().startsWith('{"UNMASKED_VENDOR_WEBGL"')) {
      (out.webgl ||= []).push(name);
      continue;
    }
    if (name.endsWith('.ico')) {
      out.icon = name;
      continue;
    }
    if (/^594/.test(raw.trim())) {
      try {
        const o = JSON.parse(decodeCfg(raw));
        if (o.TimeZone !== undefined) out.dynamic = name;
        else if (o.CanvasMark !== undefined || o.UserAgentMetadata !== undefined) out.static = name;
      } catch {
        /* not a config */
      }
    }
  }
  return out;
}

const profile = findProfile();
if (!profile || !fs.existsSync(profile)) {
  console.error('没找到 AdsPower 内核 profile 目录。先启动一次 AdsPower 并打开任意环境，或用 --profile 指定。');
  process.exit(1);
}

const found = classify(profile);
if (!found.static || !found.dynamic) {
  console.error(`目录里没有可用的 staticconfig / dynamicconfig: ${profile}`);
  process.exit(1);
}

fs.rmSync(SEED, { recursive: true, force: true });
fs.mkdirSync(SEED, { recursive: true });
for (const name of [found.static, found.dynamic, found.cookies, found.icon, ...(found.webgl || [])]) {
  if (!name) continue;
  fs.copyFileSync(path.join(profile, name), path.join(SEED, name));
}

const st = JSON.parse(decodeCfg(fs.readFileSync(path.join(profile, found.static), 'utf8')));
const dyn = JSON.parse(decodeCfg(fs.readFileSync(path.join(profile, found.dynamic), 'utf8')));
const srcDir = profile;
const srcName = path.basename(profile);
const p = (name) => path.join(srcDir, name);

// same shape the kernel broadcasts in --extended-parameters
const ext = {
  UserId: st.UserId,
  CanvasMark: st.CanvasMark,
  DisableContainer: st.DisableContainer,
  WebGLMark: st.WebGLMark,
  StartTime: st.StartTime,
  LoadExtensionErrorBox: st.LoadExtensionErrorBox,
  ForceProcessExit: st.ForceProcessExit,
  CustomIcon: found.icon ? p(found.icon) : '',
  AllowScanPorts: st.AllowScanPorts,
  GeolocationSetting: st.GeolocationSetting,
  FlashPluginSetting: st.FlashPluginSetting,
  Platform: st.Platform,
  DisableBackgroundMode: st.DisableBackgroundMode,
  HardwareConcurrency: st.HardwareConcurrency,
  DeviceMemory: st.DeviceMemory,
  ClientRectFp: st.ClientRectFp,
  WebGLFP: found.webgl?.length ? p(found.webgl.find((n) => n.endsWith('_Other')) || found.webgl[0]) : '',
  CookiesFile: found.cookies ? p(found.cookies) : '',
  Langs: st.Langs,
  AcceptLang: st.AcceptLang,
  TimeZone: dyn.TimeZone,
  Geoposition: dyn.Geoposition,
  DynamicConfig: p(found.dynamic),
  StaticConfig: p(found.static),
};

const meta = { srcDir, srcName, extBlob: encodeCfg(JSON.stringify(ext)) };
fs.writeFileSync(path.join(ASSETS, 'tpl_meta.json'), JSON.stringify(meta), 'utf8');

console.log('内核种子资源已生成');
console.log('  来源 profile:', profile);
console.log('  种子文件:', fs.readdirSync(SEED).join(', '));
console.log('  tpl_meta.json: srcDir / srcName / extBlob（由种子配置重建）');
console.log('  文件名校验:', JSON.stringify(profileFileNames(srcName)));
