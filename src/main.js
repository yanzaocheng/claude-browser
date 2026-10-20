#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, DEFAULT_PORT } from './app.js';
import { resolveShell } from './browser-finder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.CLAUDE_BROWSER_PORT || process.env.FPB_PORT) || DEFAULT_PORT,
    dataDir: process.env.CLAUDE_BROWSER_DATA_DIR || process.env.FPB_DATA_DIR || path.join(ROOT, 'data'),
    open: true,
    debug: false,
    shell: process.env.CLAUDE_BROWSER_SHELL || process.env.FPB_SHELL || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--data') opts.dataDir = path.resolve(argv[++i]);
    else if (a.startsWith('--data=')) opts.dataDir = path.resolve(a.slice(7));
    else if (a === '--no-open') opts.open = false;
    else if (a === '--shell') opts.shell = argv[++i];
    else if (a.startsWith('--shell=')) opts.shell = a.slice(8);
    else if (a === '--debug') opts.debug = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node src/main.js [--port 50325] [--data ./data] [--no-open] [--shell auto|edge|chrome|browser] [--debug]');
      process.exit(0);
    }
  }
  return opts;
}

/**
 * Opens the management UI as a standalone app window (Chromium --app), else the default browser.
 * Windows always ships Edge, so "auto" works without the user installing Chrome.
 */
function openWindow(url, dataDir, { shell = 'auto' } = {}) {
  const host = resolveShell(shell);
  if (host) {
    try {
      const child = spawn(
        host.path,
        [
          `--app=${url}`,
          `--user-data-dir=${path.join(dataDir, host.kind === 'chrome' ? 'ui-window' : `ui-window-${host.kind}`)}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1440,900',
        ],
        { stdio: 'ignore', detached: true },
      );
      child.on('error', () => {});
      child.unref();
      return host.kind;
    } catch {}
  }
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  return 'browser';
}

async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/system`, { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Listens on the preferred port, else the next free one: on Windows, Hyper-V/WSL often reserve
 * port ranges (see `netsh int ipv4 show excludedportrange protocol=tcp`), 50325 included.
 */
async function listen(app, preferred, explicit) {
  const ports = explicit ? [preferred] : [preferred, ...Array.from({ length: 300 }, (_, i) => preferred + 1 + i), 0];
  for (const port of ports) {
    try {
      return await app.listen(port);
    } catch (e) {
      if (e.code === 'EADDRINUSE' && (await alreadyRunning(port))) return { running: port };
      if (explicit || !['EACCES', 'EADDRINUSE'].includes(e.code)) throw e;
    }
  }
  throw new Error('没有可用端口');
}

const opts = parseArgs(process.argv.slice(2));
const explicitPort = process.argv.some((a) => a === '--port' || a.startsWith('--port=')) || !!(process.env.CLAUDE_BROWSER_PORT || process.env.FPB_PORT);
const portFile = path.join(opts.dataDir, '.port');
// an instance using this data directory may already run on a fallback port
const lastPort = Number(fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8'));
if (lastPort && (await alreadyRunning(lastPort))) {
  console.log(`Claude Browser 已在运行: http://127.0.0.1:${lastPort}`);
  if (opts.open) openWindow(`http://127.0.0.1:${lastPort}/`, opts.dataDir, '');
  process.exit(0);
}

const app = createApp({ dataDir: opts.dataDir, port: opts.port, debug: opts.debug });
try {
  const r = await listen(app, opts.port, explicitPort);
  if (r?.running) {
    console.log(`Claude Browser 已在运行: http://127.0.0.1:${r.running}`);
    if (opts.open) openWindow(`http://127.0.0.1:${r.running}/`, opts.dataDir, app.store.settings.browserPath);
    process.exit(0);
  }
} catch (e) {
  console.error(['EADDRINUSE', 'EACCES'].includes(e.code) ? `端口 ${opts.port} 不可用（${e.code}），可用 --port 指定其他端口` : e);
  process.exit(1);
}
fs.writeFileSync(portFile, String(new URL(app.baseUrl).port));

const actualPort = Number(new URL(app.baseUrl).port);
console.log(`Claude Browser 指纹浏览器已启动
  管理界面:  ${app.baseUrl}/
  本地 API:  ${app.baseUrl}/api/v1/...   (兼容 AdsPower Local API)
  数据目录:  ${opts.dataDir}${actualPort !== opts.port ? `\n  注意: 端口 ${opts.port} 被系统保留或占用，已改用 ${actualPort}；AdsPower 脚本请把端口改为 ${actualPort}` : ''}
按 Ctrl+C 退出（会关闭所有已打开的环境）`);
if (opts.open) openWindow(`${app.baseUrl}/`, opts.dataDir, app.store.settings.browserPath);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('\n正在关闭所有环境...');
  const force = setTimeout(() => process.exit(0), 15000);
  await app.close().catch(() => {});
  clearTimeout(force);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
