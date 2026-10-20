/**
 * Builds a self-contained folder that runs on a machine with nothing installed:
 * our code + a copy of the Node runtime + a launcher .bat. The management window is opened by
 * the system's Edge / Chrome in --app mode, and profiles can run on either the browser or the
 * SunBrowser kernel, so the recipient does not need Node or Chrome.
 *
 *   node scripts/package.mjs            # dist/claude-browser-<version>/
 *   node scripts/package.mjs --zip      # ... plus dist/claude-browser-<version>.zip
 *   node scripts/package.mjs --no-node  # skip node.exe (recipient already has Node >= 22)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const withZip = args.includes('--zip');
const withNode = !args.includes('--no-node');

const outRoot = path.join(ROOT, 'dist');
const dir = path.join(outRoot, `claude-browser-${pkg.version}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

for (const name of ['src', 'public', 'assets']) {
  const from = path.join(ROOT, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, name), { recursive: true });
}
for (const name of ['package.json', 'README.md']) {
  const from = path.join(ROOT, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, name));
}

const nodeTarget = path.join(dir, 'node.exe');
if (withNode) fs.copyFileSync(process.execPath, nodeTarget);

const bat = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'echo Claude Browser 正在启动，窗口马上就出来…（这个黑框是服务日志，关掉它就会关闭所有环境）',
  'echo.',
  withNode ? 'node.exe src\\main.js' : 'node src\\main.js',
  'echo.',
  'echo 服务已退出。按任意键关闭。',
  'pause >nul',
  '',
].join('\r\n');
fs.writeFileSync(path.join(dir, '启动 Claude Browser.bat'), '\uFEFF' + bat, 'utf8');

const readme = [
  'Claude Browser 指纹浏览器 · 便携版',
  '',
  '1) 双击「启动 Claude Browser.bat」',
  '2) 会自动弹出管理窗口（Windows 优先用系统自带的 Edge，不需要另装 Chrome）',
  '3) 环境默认用系统 Chrome / Edge 起浏览器；也可以在「设置 → 内核」里切成 SunBrowser 内核',
  '',
  '数据都放在本文件夹的 data\\ 下，整个文件夹可以拷走/删掉。',
  '端口默认 50325，被占用会自动顺延，实际端口显示在窗口左下角和命令行里。',
  withNode ? '' : '',
].join('\r\n');
fs.writeFileSync(path.join(dir, '使用说明.txt'), '\uFEFF' + readme, 'utf8');

const size = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`输出目录: ${dir}`);
console.log(`  体积: ${mb(size(dir))}${withNode ? '（含 node.exe）' : '（不含 node.exe）'}`);

if (withZip) {
  const zipName = `claude-browser-${pkg.version}.zip`;
  const zip = path.join(outRoot, zipName);
  fs.rmSync(zip, { force: true });
  // Keep the archive path relative: Windows tar interprets an absolute `D:\\...` path as a remote archive.
  const r = spawnSync('tar', ['-a', '-cf', path.join('..', zipName), '.'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`打包失败: ${r.stderr || r.stdout}`);
  console.log(` 压缩包: ${zip}  ${mb(fs.statSync(zip).size)}`);
}
