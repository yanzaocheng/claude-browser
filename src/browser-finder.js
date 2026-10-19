import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const list = [];
    for (const r of roots) list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) list.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    return list;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  const dirs = (env.PATH || '/usr/bin').split(':');
  return names.flatMap((n) => dirs.map((d) => path.join(d, n)));
}

export function browserKind(exe) {
  const s = exe.toLowerCase();
  if (s.includes('edge')) return 'edge';
  if (s.includes('chromium')) return 'chromium';
  return 'chrome';
}

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

/** Reads the browser version without starting it (Windows: version folders next to the exe). */
export function detectVersion(exe) {
  try {
    if (process.platform === 'win32') {
      const entries = fs.readdirSync(path.dirname(exe));
      const dirs = entries.filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort(cmpVersion);
      // a staged update (new_chrome.exe / new_msedge.exe) already has its version folder: the running exe is the older one
      const staged = entries.some((e) => /^new_(chrome|msedge)\.exe$/i.test(e));
      if (dirs.length) return staged && dirs.length > 1 ? dirs.at(-2) : dirs.at(-1);
      return null; // chrome.exe --version prints nothing on Windows
    }
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return out.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

export function findBrowsers() {
  const seen = new Set();
  const out = [];
  for (const exe of candidates()) {
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fs.statSync(exe).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ path: exe, kind: browserKind(exe), version: detectVersion(exe) });
  }
  return out;
}

/** Resolves the browser to use: the configured path, else the first Chrome/Edge found. */
/**
 * Which Chromium build should host the management window.
 * On Windows Edge is always installed, so "auto" never depends on the user having Chrome.
 * Returns null when the caller should fall back to the default browser.
 */
export function resolveShell(preference = 'auto') {
  const list = findBrowsers();
  const pick = (kind) => list.find((b) => b.kind === kind) || null;
  if (preference === 'browser') return null;
  if (preference === 'edge') return pick('edge') || null;
  if (preference === 'chrome') return pick('chrome') || pick('chromium') || null;
  if (process.platform === 'win32') return pick('edge') || list[0] || null;
  return list[0] || null;
}

export function resolveBrowser(configuredPath) {
  let info;
  if (configuredPath) {
    if (!fs.existsSync(configuredPath)) throw new Error(`浏览器路径不存在: ${configuredPath}`);
    info = { path: configuredPath, kind: browserKind(configuredPath), version: detectVersion(configuredPath) };
  } else {
    info = findBrowsers()[0];
    if (!info) throw new Error('未找到 Chrome / Edge，请在「设置」中指定浏览器路径');
  }
  return { ...info, major: info.version ? Number(info.version.split('.')[0]) : null };
}
