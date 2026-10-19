/**
 * Sync a SunBrowser kernel from AdsPower's CDN.
 *
 *   node scripts/sync-kernel.mjs --list
 *   node scripts/sync-kernel.mjs --kernel 155 [--force]
 *
 * The version list comes from the same endpoint the AdsPower client uses
 * (client/sys-version/list). The login token is read from the AdsPower client's localStorage,
 * so no patching and no env var is needed once AdsPower has been started:
 *   --token ... | ADSPOWER_TOKEN=... overrides it.
 *
 * Download + md5 check + unpack into %APPDATA%\adspower_global\cwd_global\chrome_<ver>,
 * which is exactly where findSunBrowser() looks.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '1') : def;
};
const flag = (name) => args.includes(`--${name}`);

const DATA_ROOT = path.join(process.env.APPDATA || '', 'adspower_global', 'cwd_global');
const API = 'https://api-global.adspower.net';
const CLIENT_VERSION = opt('client-version', '8.9.23');

/** Node's fetch (undici) leaves a closing async handle behind on Windows; plain https exits clean. */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'Mozilla/5.0', connection: 'close', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), headers));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
  });
}

/** The token is what AdsPower's own web UI keeps in localStorage (key KEY_IN_WEBSITE). */
function tokenFromAdsPowerLocalStorage() {
  const dir = path.join(process.env.APPDATA || '', 'adspower_global', 'Local Storage', 'leveldb');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));
  } catch {
    return '';
  }
  for (const f of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, f), 'latin1');
    } catch {
      continue;
    }
    const m = raw.match(/KEY_IN_WEBSITE[^0-9a-f]{0,60}([0-9a-f]{48})/i);
    if (m) return m[1];
  }
  return '';
}

const TOKEN = opt('token') || process.env.ADSPOWER_TOKEN || tokenFromAdsPowerLocalStorage();
if (!TOKEN) throw new Error('缺少 token：--token / ADSPOWER_TOKEN，或先启动一次 AdsPower 客户端（从它的 localStorage 自动读取）');

async function versionList() {
  const url = `${API}/client/sys-version/list?version=${encodeURIComponent(CLIENT_VERSION)}&system=x64`;
  const res = await httpGet(url, { 'login-token': TOKEN });
  let body = '';
  for await (const chunk of res) body += chunk;
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`版本列表不是 JSON（HTTP ${res.statusCode}）: ${body.slice(0, 160)}`);
  }
  if (!json?.data?.kernel) throw new Error(`版本列表获取失败: ${JSON.stringify(json).slice(0, 200)}`);
  return json.data.kernel;
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex').toUpperCase()));
    s.on('error', reject);
  });
}

async function download(url, dest) {
  const res = await httpGet(url);
  if (res.statusCode !== 200) throw new Error(`下载失败 ${res.statusCode} ${url}`);
  const total = Number(res.headers['content-length'] || 0);
  let got = 0;
  let last = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res) {
    got += chunk.length;
    if (total && got - last > 8 * 1024 * 1024) {
      last = got;
      process.stdout.write(`\r  ${(got / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
    }
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r) => out.end(r));
  if (total) process.stdout.write('\n');
}

function unzip(zip, dir) {
  const r = spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败: ${r.stderr || r.stdout}`);
}

/** The zips contain either the kernel files or one wrapping folder. */
function normalise(dir, version) {
  const entries = fs.readdirSync(dir);
  const hasExe = entries.some((e) => /^sunbrowser\.exe$/i.test(e));
  const subdirs = entries.filter((e) => fs.statSync(path.join(dir, e)).isDirectory());
  const wrap = subdirs.find((d) => fs.readdirSync(path.join(dir, d)).some((f) => /^sunbrowser\.exe$/i.test(f)));
  if (!hasExe && wrap) {
    const inner = path.join(dir, wrap);
    for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(dir, f));
    fs.rmdirSync(inner);
  }
  const dirs = fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
  return { files: fs.readdirSync(dir), versionDirs: dirs, version };
}

const list = await versionList();
const chromeKernels = list.filter((k) => k.type === 'chrome').sort((a, b) => Number(a.kernel) - Number(b.kernel));
if (flag('list') || !opt('kernel')) {
  console.log('可用的 Chrome 内核：');
  for (const k of chromeKernels) {
    const local = fs.existsSync(path.join(DATA_ROOT, `chrome_${k.kernel}`));
    console.log(`  ${String(k.kernel).padStart(3)}  ${k.version}  ${String(k.size).padStart(9)}  ${local ? '[已安装]' : '         '}  ${k.download_url}`);
  }
  process.exitCode = 0;
} else {
  const wanted = String(opt('kernel'));
  const entry = chromeKernels.find((k) => String(k.kernel) === wanted);
  if (!entry) throw new Error(`没有内核 ${wanted}，可用：${chromeKernels.map((k) => k.kernel).join(',')}`);

  const target = path.join(DATA_ROOT, `chrome_${wanted}`);
  if (fs.existsSync(target) && !flag('force')) {
    console.log(`chrome_${wanted} 已存在，加 --force 覆盖`);
  } else {
    const tmp = path.join(DATA_ROOT, `_download_${wanted}.zip`);
    console.log(`下载 ${entry.download_url}`);
    await download(entry.download_url, tmp);

    const md5 = await md5File(tmp);
    console.log(`md5 ${md5} (expected ${entry.file_md5})`);
    if (entry.file_md5 && md5 !== String(entry.file_md5).toUpperCase()) throw new Error('md5 校验失败，包不完整');

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    unzip(tmp, target);
    fs.rmSync(tmp, { force: true });
    const info = normalise(target, entry.version);
    console.log(`安装到 ${target}`);
    console.log('  文件:', info.files.join(', '));
    console.log('  版本目录:', info.versionDirs.join(', ') || '(无)');
  }
}
