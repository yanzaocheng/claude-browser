import { pick, randomSeed } from './util.js';

export const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

export function hostOS() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

const NAV_PLATFORM = { windows: 'Win32', macos: 'MacIntel', linux: 'Linux x86_64' };
const UA_PLATFORM = { windows: 'Windows NT 10.0; Win64; x64', macos: 'Macintosh; Intel Mac OS X 10_15_7', linux: 'X11; Linux x86_64' };
const PLATFORM_VERSIONS = { windows: ['10.0.0', '15.0.0', '19.0.0'], macos: ['13.6.0', '14.6.1', '15.5.0'], linux: ['6.5.0', '6.8.0'] };

export const SCREENS = {
  windows: [[1920, 1080], [1366, 768], [1536, 864], [1440, 900], [1600, 900], [2560, 1440], [1280, 720], [1680, 1050], [1920, 1200]],
  macos: [[1440, 900], [1512, 982], [1680, 1050], [1728, 1117], [1920, 1080], [2560, 1440], [1280, 800]],
  linux: [[1920, 1080], [1366, 768], [1600, 900], [2560, 1440], [1280, 1024]],
};

export const GPUS = {
  windows: [
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti (0x00001C82) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 2048SP (0x00006FDF) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ],
  macos: [
    ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'],
    ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
    ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'],
    ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)'],
    ['Google Inc. (Intel Inc.)', 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)'],
  ],
  linux: [
    ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'],
    ['Google Inc. (NVIDIA Corporation)', 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1080/PCIe/SSE2, OpenGL 4.5.0)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navi23, LLVM 15.0.7, DRM 3.49, 6.1.0-13-amd64), OpenGL 4.6)'],
  ],
};

export const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Lima', 'America/Santiago', 'Europe/London', 'Europe/Dublin',
  'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels',
  'Europe/Zurich', 'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Budapest', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Kiev',
  'Europe/Istanbul', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Tehran', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Manila',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Brisbane',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg',
  'Africa/Nairobi', 'Asia/Jerusalem',
];

export const COUNTRY_LANG = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE', IN: 'en-IN', SG: 'en-SG', PH: 'en-PH',
  ZA: 'en-ZA', NG: 'en-NG', KE: 'en-KE', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', MO: 'zh-MO', JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', FR: 'fr-FR', BE: 'fr-BE', LU: 'fr-LU', ES: 'es-ES', MX: 'es-MX', AR: 'es-AR',
  CO: 'es-CO', CL: 'es-CL', PE: 'es-PE', VE: 'es-VE', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR', NL: 'nl-NL', RU: 'ru-RU',
  BY: 'ru-RU', KZ: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL', TR: 'tr-TR', VN: 'vi-VN', TH: 'th-TH', ID: 'id-ID', MY: 'ms-MY',
  SA: 'ar-SA', AE: 'ar-AE', EG: 'ar-EG', MA: 'ar-MA', IL: 'he-IL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI',
  GR: 'el-GR', CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG', HR: 'hr-HR', RS: 'sr-RS', IR: 'fa-IR',
  PK: 'ur-PK', BD: 'bn-BD', LK: 'si-LK', KH: 'km-KH', MM: 'my-MM', LT: 'lt-LT', LV: 'lv-LV', EE: 'et-EE', SI: 'sl-SI',
};

export const LANGUAGE_PRESETS = [
  'en-US,en', 'en-GB,en', 'zh-CN,zh', 'zh-TW,zh', 'zh-HK,zh', 'ja-JP,ja', 'ko-KR,ko', 'de-DE,de', 'fr-FR,fr',
  'es-ES,es', 'es-MX,es', 'it-IT,it', 'pt-BR,pt', 'pt-PT,pt', 'ru-RU,ru', 'nl-NL,nl', 'pl-PL,pl', 'tr-TR,tr',
  'vi-VN,vi', 'th-TH,th', 'id-ID,id', 'ar-SA,ar', 'uk-UA,uk', 'sv-SE,sv',
];

// Built-in (OneCore) speech voices of a Windows install, by display language. A Windows machine
// only has the voices of its own language, so the real list gives away the real system language.
const WIN_VOICES = {
  'en-US': ['English (United States)', 'David', 'Mark', 'Zira'],
  'en-GB': ['English (United Kingdom)', 'George', 'Hazel', 'Susan'],
  'en-AU': ['English (Australia)', 'Catherine', 'James'],
  'en-CA': ['English (Canada)', 'Linda', 'Richard'],
  'en-IN': ['English (India)', 'Heera', 'Ravi'],
  'en-IE': ['English (Ireland)', 'Sean'],
  'ja-JP': ['Japanese (Japan)', 'Ayumi', 'Haruka', 'Ichiro'],
  'zh-CN': ['Chinese (Simplified, PRC)', 'Huihui', 'Kangkang', 'Yaoyao'],
  'zh-TW': ['Chinese (Traditional, Taiwan)', 'Hanhan', 'Yating', 'Zhiwei'],
  'zh-HK': ['Chinese (Traditional, Hong Kong S.A.R.)', 'Danny', 'Tracy'],
  'ko-KR': ['Korean (Korea)', 'Heami'],
  'de-DE': ['German (Germany)', 'Hedda', 'Katja', 'Stefan'],
  'de-AT': ['German (Austria)', 'Michael'],
  'de-CH': ['German (Switzerland)', 'Karsten'],
  'fr-FR': ['French (France)', 'Hortense', 'Julie', 'Paul'],
  'fr-CA': ['French (Canada)', 'Caroline', 'Claude', 'Nathalie'],
  'es-ES': ['Spanish (Spain)', 'Helena', 'Laura', 'Pablo'],
  'es-MX': ['Spanish (Mexico)', 'Raul', 'Sabina'],
  'it-IT': ['Italian (Italy)', 'Cosimo', 'Elsa'],
  'pt-BR': ['Portuguese (Brazil)', 'Daniel', 'Maria'],
  'pt-PT': ['Portuguese (Portugal)', 'Helia'],
  'ru-RU': ['Russian (Russia)', 'Irina', 'Pavel'],
  'nl-NL': ['Dutch (Netherlands)', 'Frank'],
  'pl-PL': ['Polish (Poland)', 'Adam', 'Paulina'],
  'tr-TR': ['Turkish (Turkey)', 'Tolga'],
  'vi-VN': ['Vietnamese (Vietnam)', 'An'],
  'th-TH': ['Thai (Thailand)', 'Pattara'],
  'id-ID': ['Indonesian (Indonesia)', 'Andika'],
  'ar-SA': ['Arabic (Saudi Arabia)', 'Naayf'],
  'ar-EG': ['Arabic (Egypt)', 'Hoda'],
  'he-IL': ['Hebrew (Israel)', 'Asaf'],
  'sv-SE': ['Swedish (Sweden)', 'Bengt'],
  'da-DK': ['Danish (Denmark)', 'Helle'],
  'fi-FI': ['Finnish (Finland)', 'Heidi'],
  'el-GR': ['Greek (Greece)', 'Stefanos'],
  'cs-CZ': ['Czech (Czech Republic)', 'Jakub'],
  'hu-HU': ['Hungarian (Hungary)', 'Szabolcs'],
  'ro-RO': ['Romanian (Romania)', 'Andrei'],
  'hi-IN': ['Hindi (India)', 'Hemant', 'Kalpana'],
};

// macOS ships the same voice set whatever the system language (Chrome lists them alphabetically).
const MAC_VOICES = [
  ['Alex', 'en-US'], ['Alice', 'it-IT'], ['Alva', 'sv-SE'], ['Amelie', 'fr-CA'], ['Anna', 'de-DE'], ['Carmit', 'he-IL'],
  ['Damayanti', 'id-ID'], ['Daniel', 'en-GB'], ['Diego', 'es-AR'], ['Ellen', 'nl-BE'], ['Fred', 'en-US'], ['Ioana', 'ro-RO'],
  ['Joana', 'pt-PT'], ['Jorge', 'es-ES'], ['Juan', 'es-MX'], ['Kanya', 'th-TH'], ['Karen', 'en-AU'], ['Kyoko', 'ja-JP'],
  ['Laura', 'sk-SK'], ['Lekha', 'hi-IN'], ['Luca', 'it-IT'], ['Luciana', 'pt-BR'], ['Maged', 'ar-SA'], ['Mariska', 'hu-HU'],
  ['Mei-Jia', 'zh-TW'], ['Melina', 'el-GR'], ['Milena', 'ru-RU'], ['Moira', 'en-IE'], ['Monica', 'es-ES'], ['Nora', 'nb-NO'],
  ['Paulina', 'es-MX'], ['Rishi', 'en-IN'], ['Samantha', 'en-US'], ['Sara', 'da-DK'], ['Satu', 'fi-FI'], ['Sin-ji', 'zh-HK'],
  ['Tessa', 'en-ZA'], ['Thomas', 'fr-FR'], ['Ting-Ting', 'zh-CN'], ['Veena', 'en-IN'], ['Victoria', 'en-US'], ['Xander', 'nl-NL'],
  ['Yelda', 'tr-TR'], ['Yuna', 'ko-KR'], ['Yuri', 'ru-RU'], ['Zosia', 'pl-PL'], ['Zuzana', 'cs-CZ'],
];

/**
 * The local (OS) speech voices a machine of this OS and language would have; remote "Google …"
 * voices come from the browser itself and stay as they are. `defaultIndex` is the system default.
 */
export function speechVoices(os, locale = 'en-US') {
  const base = locale.split('-')[0];
  if (os === 'windows') {
    const key = WIN_VOICES[locale] ? locale : Object.keys(WIN_VOICES).find((k) => k.split('-')[0] === base) || 'en-US';
    const [label, ...names] = WIN_VOICES[key];
    return { list: names.map((n) => ({ name: `Microsoft ${n} - ${label}`, lang: key })), defaultIndex: 0 };
  }
  if (os === 'macos') {
    let idx = MAC_VOICES.findIndex(([, l]) => l === locale);
    if (idx < 0) idx = MAC_VOICES.findIndex(([, l]) => l.split('-')[0] === base);
    if (idx < 0 || base === 'en') idx = MAC_VOICES.findIndex(([n]) => n === (locale === 'en-GB' ? 'Daniel' : 'Samantha'));
    return { list: MAC_VOICES.map(([name, lang]) => ({ name, lang })), defaultIndex: idx };
  }
  return { list: [], defaultIndex: -1 }; // Linux desktops usually have no local voices
}

/** Work area of a screen of this OS: Windows taskbar at the bottom, macOS menu bar at the top. */
export function screenArea(os, width, height, platformVersion) {
  if (os === 'windows') {
    const taskbar = Number(String(platformVersion).split('.')[0]) >= 13 ? 48 : 40; // Windows 11 : 10
    return { width, height, availWidth: width, availHeight: height - taskbar, availLeft: 0, availTop: 0 };
  }
  if (os === 'macos') return { width, height, availWidth: width, availHeight: height - 25, availLeft: 0, availTop: 25 };
  return { width, height, availWidth: width, availHeight: height, availLeft: 0, availTop: 0 };
}

/** 'ja-JP' -> ['ja-JP', 'ja', 'en-US', 'en'] (how a Japanese Chrome install usually looks). */
export function languagesForLocale(locale) {
  const base = locale.split('-')[0];
  const list = [locale];
  if (base !== locale) list.push(base);
  if (base !== 'en') list.push('en-US', 'en');
  return list;
}

export function parseLanguages(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.split(';')[0].trim())
    .filter((s) => /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(s));
}

export function defaultFingerprint(os = hostOS()) {
  if (!OS_NAMES[os]) os = hostOS();
  const [vendor, renderer] = pick(GPUS[os]);
  return {
    os,
    userAgent: '', // empty = generated from the real browser version
    platformVersion: pick(PLATFORM_VERSIONS[os]),
    language: { mode: 'ip', value: 'en-US,en' }, // ip | custom
    timezone: { mode: 'ip', value: 'America/New_York' }, // ip | real | custom
    geolocation: { permission: 'ask', mode: 'ip', latitude: 40.7128, longitude: -74.006, accuracy: 100 }, // permission ask|allow|block; mode ip|custom
    webrtc: 'proxy', // proxy (no non-proxied UDP) | disabled | real
    screen: { mode: 'real', width: 1920, height: 1080 }, // real | custom
    hardwareConcurrency: pick([4, 8, 8, 12, 16]), // 0 = real
    deviceMemory: pick([4, 8, 8]), // 0 = real
    canvas: 'noise', // noise | real
    webglImage: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webgl: { mode: 'custom', vendor, renderer }, // custom | real
    voices: 'match', // match (system voices of the profile's OS + language) | real
    seed: randomSeed(),
  };
}

/** A fresh random fingerprint; keeps the screen mode of `prev` (custom screens get a random size). */
export function randomFingerprint(os, prev) {
  const fp = defaultFingerprint(os);
  if (prev?.screen?.mode === 'custom') {
    const [width, height] = pick(SCREENS[fp.os]);
    fp.screen = { mode: 'custom', width, height };
  }
  return fp;
}

const oneOf = (v, allowed, d) => (allowed.includes(v) ? v : d);
const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

/** Merges user input over a base fingerprint and validates every field. */
export function normalizeFingerprint(input = {}, base) {
  const i = input || {};
  const b = { ...defaultFingerprint(i.os || base?.os), ...(base ? structuredClone(base) : {}) };
  const fp = { ...b };
  fp.os = oneOf(i.os, Object.keys(OS_NAMES), b.os);
  if (fp.os !== b.os && !i.platformVersion) fp.platformVersion = pick(PLATFORM_VERSIONS[fp.os]);
  if (i.platformVersion !== undefined) fp.platformVersion = /^\d+\.\d+\.\d+$/.test(i.platformVersion) ? i.platformVersion : b.platformVersion;
  if (i.userAgent !== undefined) fp.userAgent = String(i.userAgent || '').trim().slice(0, 500);
  const lang = { ...b.language, ...(i.language || {}) };
  fp.language = { mode: oneOf(lang.mode, ['ip', 'custom'], 'ip'), value: parseLanguages(lang.value).join(',') || 'en-US,en' };
  const tz = { ...b.timezone, ...(i.timezone || {}) };
  fp.timezone = { mode: oneOf(tz.mode, ['ip', 'real', 'custom'], 'ip'), value: isTimezone(tz.value) ? tz.value : 'America/New_York' };
  const geo = { ...b.geolocation, ...(i.geolocation || {}) };
  fp.geolocation = {
    permission: oneOf(geo.permission, ['ask', 'allow', 'block'], 'ask'),
    mode: oneOf(geo.mode, ['ip', 'custom'], 'ip'),
    latitude: num(geo.latitude, 0, -90, 90),
    longitude: num(geo.longitude, 0, -180, 180),
    accuracy: num(geo.accuracy, 100, 1, 100000),
  };
  fp.webrtc = oneOf(i.webrtc ?? b.webrtc, ['proxy', 'disabled', 'real'], 'proxy');
  const sc = { ...b.screen, ...(i.screen || {}) };
  fp.screen = { mode: oneOf(sc.mode, ['real', 'custom'], 'real'), width: num(sc.width, 1920, 320, 10000) | 0, height: num(sc.height, 1080, 240, 10000) | 0 };
  fp.hardwareConcurrency = oneOf(Number(i.hardwareConcurrency ?? b.hardwareConcurrency), [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32], 8);
  fp.deviceMemory = oneOf(Number(i.deviceMemory ?? b.deviceMemory), [0, 1, 2, 4, 8], 8);
  for (const k of ['canvas', 'webglImage', 'audio', 'clientRects']) fp[k] = oneOf(i[k] ?? b[k], ['noise', 'real'], 'noise');
  const gl = { ...b.webgl, ...(i.webgl || {}) };
  fp.webgl = { mode: oneOf(gl.mode, ['custom', 'real'], 'custom'), vendor: String(gl.vendor || '').slice(0, 200), renderer: String(gl.renderer || '').slice(0, 300) };
  if (fp.webgl.mode === 'custom' && (!fp.webgl.vendor || !fp.webgl.renderer)) [fp.webgl.vendor, fp.webgl.renderer] = pick(GPUS[fp.os]);
  fp.voices = oneOf(i.voices ?? b.voices, ['match', 'real'], 'match');
  fp.seed = num(i.seed ?? b.seed, 0, 1, 0x7fffffff) | 0 || randomSeed();
  return fp;
}

export function isTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- runtime

export function buildUserAgent(os, major, kind) {
  let ua = `Mozilla/5.0 (${UA_PLATFORM[os]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  if (kind === 'edge') ua += ` Edg/${major}.0.0.0`;
  return ua;
}

export function osFromUserAgent(ua) {
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) return 'macos';
  if (/Linux|X11|CrOS/.test(ua) && !/Android/.test(ua)) return 'linux';
  return null;
}

/**
 * The user-agent client hints brand list, using Chromium's GREASE algorithm
 * (components/embedder_support/user_agent_utils.cc, seeded by the major version).
 */
export function brandLists(major, kind, fullVersion) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseVersions = ['8', '99', '24'];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const order = orders[major % 6];
  const greaseBrand = `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`;
  const greaseVersion = greaseVersions[major % 3];
  const brandName = kind === 'edge' ? 'Microsoft Edge' : kind === 'chromium' ? null : 'Google Chrome';
  const make = (full) => {
    const list = [];
    list[order[0]] = { brand: greaseBrand, version: full ? `${greaseVersion}.0.0.0` : greaseVersion };
    list[order[1]] = { brand: 'Chromium', version: full ? fullVersion : String(major) };
    list[order[2]] = brandName ? { brand: brandName, version: full ? fullVersion : String(major) } : null;
    return list.filter(Boolean);
  };
  return { brands: make(false), fullVersionList: make(true) };
}

function gpuVendorKey(vendor) {
  const v = vendor.toLowerCase();
  if (v.includes('nvidia')) return ['nvidia', 'ampere'];
  if (v.includes('amd') || v.includes('ati')) return ['amd', 'rdna-2'];
  if (v.includes('apple')) return ['apple', 'metal-3'];
  if (v.includes('intel')) return ['intel', 'gen-12lp'];
  return ['', ''];
}

/**
 * Turns a stored profile fingerprint plus the proxy's IP information into the concrete values
 * applied to the browser (flags, CDP overrides and the injected script config).
 */
export function resolveRuntime(fpIn, ipInfo, browser) {
  const f = normalizeFingerprint(fpIn, fpIn);
  const customUA = f.userAgent;
  const os = (customUA && osFromUserAgent(customUA)) || f.os;
  const major = Number(customUA.match(/Chrome\/(\d+)/)?.[1]) || browser.major || null;
  const userAgent = customUA || (major ? buildUserAgent(os, major, browser.kind) : null);

  let languages = null;
  if (f.language.mode === 'custom') languages = parseLanguages(f.language.value);
  else if (ipInfo?.countryCode) languages = languagesForLocale(COUNTRY_LANG[ipInfo.countryCode] || 'en-US');
  if (languages && !languages.length) languages = null;

  let timezone = null;
  if (f.timezone.mode === 'custom') timezone = f.timezone.value;
  else if (f.timezone.mode === 'ip' && isTimezone(ipInfo?.timezone)) timezone = ipInfo.timezone;

  let geolocation = null;
  if (f.geolocation.permission !== 'block') {
    if (f.geolocation.mode === 'custom') geolocation = { latitude: f.geolocation.latitude, longitude: f.geolocation.longitude, accuracy: f.geolocation.accuracy };
    else if (ipInfo && Number.isFinite(ipInfo.lat) && Number.isFinite(ipInfo.lon)) geolocation = { latitude: ipInfo.lat, longitude: ipInfo.lon, accuracy: f.geolocation.accuracy };
  }

  const screen = f.screen.mode === 'custom' ? screenArea(os, f.screen.width, f.screen.height, f.platformVersion) : null;
  const webgl = f.webgl.mode === 'custom' && f.webgl.vendor && f.webgl.renderer ? { vendor: f.webgl.vendor, renderer: f.webgl.renderer } : null;
  if (webgl) [webgl.gpuVendor, webgl.gpuArch] = gpuVendorKey(webgl.vendor);
  const appleSilicon = os === 'macos' && webgl && /Apple M\d/.test(webgl.renderer);
  const hostLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const voices = f.voices === 'match' ? speechVoices(os, languages?.[0] || hostLocale) : null;

  return {
    os,
    major,
    userAgent,
    customUserAgent: !!customUA,
    navPlatform: NAV_PLATFORM[os],
    uaPlatform: OS_NAMES[os],
    platformVersion: f.platformVersion,
    architecture: appleSilicon ? 'arm' : 'x86',
    languages,
    timezone,
    geolocation,
    geoPermission: f.geolocation.permission,
    webrtc: f.webrtc,
    screen,
    // Macs ship wide-gamut (P3) panels; most Windows/Linux monitors are sRGB
    colorGamut: os === 'macos' ? 'p3' : 'srgb',
    hardwareConcurrency: f.hardwareConcurrency || 0,
    deviceMemory: f.deviceMemory || 0,
    // config of the script injected into pages, frames and workers (see inject/spoof.js)
    spoof: {
      seed: f.seed,
      deviceMemory: f.deviceMemory || 0,
      canvas: f.canvas === 'noise',
      webglImage: f.webglImage === 'noise',
      audio: f.audio === 'noise',
      rects: f.clientRects === 'noise',
      webgl,
      webrtcDisabled: f.webrtc === 'disabled',
      screen,
      voices,
    },
  };
}

/** Request header values matching a UA override (lower-case names). */
export function clientHintHeaders(o) {
  const m = o.userAgentMetadata;
  const list = (l) => l.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  return {
    'user-agent': o.userAgent,
    'sec-ch-ua': list(m.brands),
    'sec-ch-ua-mobile': m.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${m.platform}"`,
    'sec-ch-ua-platform-version': `"${m.platformVersion}"`,
    'sec-ch-ua-full-version-list': list(m.fullVersionList),
    'sec-ch-ua-full-version': `"${m.fullVersion}"`,
    'sec-ch-ua-arch': `"${m.architecture}"`,
    'sec-ch-ua-bitness': `"${m.bitness}"`,
    'sec-ch-ua-model': `"${m.model}"`,
    'sec-ch-ua-wow64': m.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': (m.formFactors || ['Desktop']).map((f) => `"${f}"`).join(', '),
  };
}

/** The Emulation/Network.setUserAgentOverride parameters (UA string + client hints). */
export function buildUAOverride(rt, browser, fullVersion) {
  if (!rt.userAgent) return null;
  const major = rt.major || Number(String(fullVersion).split('.')[0]);
  const full = rt.customUserAgent && rt.major !== browser.major ? `${major}.0.0.0` : fullVersion || `${major}.0.0.0`;
  const { brands, fullVersionList } = brandLists(major, browser.kind, full);
  const o = {
    userAgent: rt.userAgent,
    platform: rt.navPlatform,
    userAgentMetadata: {
      brands,
      fullVersionList,
      fullVersion: full,
      platform: rt.uaPlatform,
      platformVersion: rt.platformVersion,
      architecture: rt.architecture,
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
      formFactors: ['Desktop'],
    },
  };
  if (rt.languages) o.acceptLanguage = rt.languages.join(',');
  return o;
}
