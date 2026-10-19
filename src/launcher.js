import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CDPConnection } from './cdp.js';
import { FingerprintController } from './controller.js';
import { resolveBrowser } from './browser-finder.js';
import { findSunBrowser, prepareSunBrowserProfile, buildSunBrowserArgs, SunBrowserController, sanePlatformVersion } from './kernel-sunbrowser.js';
import { resolveRuntime, hostOS, buildUAOverride } from './fingerprint.js';
import { normalizeProxy, hasProxy, startForwarder } from './proxy-chain.js';
import { lookupIp } from './ipinfo.js';
import { toCdpCookies, fromCdpCookies } from './cookies.js';
import { sleep, readJson, writeFileAtomic, rmrf } from './util.js';

const BLOCKED_ARGS = /^--(user-data-dir|remote-debugging-port|remote-debugging-pipe)(=|$)/;

function setPath(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
}

function needsIpLookup(fp) {
  return fp?.timezone?.mode === 'ip' || fp?.language?.mode === 'ip' || (fp?.geolocation?.mode === 'ip' && fp?.geolocation?.permission !== 'block');
}

async function waitDevToolsPort(dir, proc, timeout, stderr) {
  const file = path.join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (proc.exitCode !== null || proc.signalCode) {
      const tail = stderr().trim().split('\n').slice(-3).join(' ');
      throw new Error(
        proc.exitCode === 0
          ? '浏览器启动后立即退出：该环境可能已在另一个浏览器进程中打开，请先关闭它'
          : `浏览器启动失败 (exit ${proc.exitCode ?? proc.signalCode})${tail ? `: ${tail}` : ''}`,
      );
    }
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      if (port && wsPath) return { port: Number(port), wsPath };
    } catch {}
    await sleep(80);
  }
  throw new Error('等待浏览器启动超时');
}

/** Starts, tracks and stops one browser process per profile. */
export class Launcher extends EventEmitter {
  constructor({ store, dataDir, getServerUrl, debug = false }) {
    super();
    this.store = store;
    this.dataDir = dataDir;
    this.getServerUrl = getServerUrl || (() => null);
    this.debug = debug;
    this.running = new Map();
    this.starting = new Set();
    this.locks = new Map();
  }

  profileDir(id) {
    return path.join(this.dataDir, 'browsers', id);
  }

  status(id) {
    if (this.running.has(id)) return 'running';
    if (this.starting.has(id)) return 'starting';
    return 'stopped';
  }

  info(id) {
    const inst = this.running.get(id);
    if (!inst) return null;
    return {
      id,
      status: 'running',
      debugPort: inst.port,
      ws: inst.wsEndpoint,
      pid: inst.proc.pid,
      startedAt: inst.startedAt,
      headless: inst.headless,
      ipInfo: inst.ipInfo,
      browser: { kind: inst.browser.kind, version: inst.controller.fullVersion },
      fingerprint: {
        userAgent: inst.rt.userAgent,
        os: inst.rt.os,
        languages: inst.rt.languages,
        timezone: inst.rt.timezone,
        geolocation: inst.rt.geolocation,
        screen: inst.rt.screen,
        hardwareConcurrency: inst.rt.hardwareConcurrency,
        deviceMemory: inst.rt.deviceMemory,
        webgl: inst.rt.spoof.webgl,
        webrtc: inst.rt.webrtc,
      },
    };
  }

  /** Serializes start/stop/cookie operations per profile. */
  withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  emitStatus(id) {
    this.emit('status', { id, status: this.status(id), info: this.info(id) });
  }

  start(id, opts = {}) {
    if (this.running.has(id)) return Promise.resolve(this.info(id));
    this.starting.add(id);
    this.emitStatus(id);
    return this.withLock(id, async () => {
      if (this.running.has(id)) return this.info(id);
      try {
        return await this._start(id, opts);
      } finally {
        this.starting.delete(id);
        this.emitStatus(id);
      }
    });
  }

  async _start(id, { headless = false, openUrls, extraArgs = [], ipTab } = {}) {
    const profile = this.store.getProfile(id);
    if (!profile) throw new Error(`环境不存在: ${id}`);
    const settings = this.store.settings;
    const useKernel = settings.kernel === 'sunbrowser' || profile.kernel === 'sunbrowser';
    const sunBrowser = useKernel ? findSunBrowser(settings.sunBrowserPath) : null;
    if (useKernel && !sunBrowser) {
      throw new Error('没找到 SunBrowser 内核：请先在设置里填写 sunbrowser.exe 路径（AdsPower 客户端在 %APPDATA%\\adspower_global\\cwd_global\\chrome_*\\）');
    }
    let browser;
    try {
      browser = resolveBrowser(settings.browserPath);
    } catch (e) {
      if (!sunBrowser) throw e;
      browser = { kind: 'chrome', path: sunBrowser.path, version: sunBrowser.version, major: Number(String(sunBrowser.version).split('.')[0]) };
    }
    if (sunBrowser) {
      browser = { ...browser, kind: 'chrome', path: sunBrowser.path, version: sunBrowser.version, version0: sunBrowser.version, major: Number(String(sunBrowser.version).split('.')[0]) };
    }
    const userDataDir = path.resolve(this.profileDir(id));
    fs.mkdirSync(userDataDir, { recursive: true });
    await this.closeOrphan(userDataDir);

    const proxy = normalizeProxy(profile.proxy);
    let ipInfo = null;
    let forwarder = null;
    let proc = null;
    let conn = null;
    let stderrBuf = '';
    try {
      if (hasProxy(proxy)) {
        try {
          ipInfo = await lookupIp(proxy);
        } catch (e) {
          if (e.proxyError) throw new Error(`代理不可用: ${e.message}`);
          this.debugLog(id, `IP lookup failed: ${e.message}`);
        }
        forwarder = await startForwarder(proxy);
      } else if (needsIpLookup(profile.fingerprint)) {
        ipInfo = await lookupIp(null, { timeout: 5000 }).catch(() => null);
      }
      // IP services can be down: fall back to the last known exit IP so ip-based settings stay put
      const geoInfo = ipInfo || profile.lastIpInfo || null;
      const rt = resolveRuntime(profile.fingerprint, geoInfo, browser);

      // WebRTC: only restrict UDP when there is really something to leak, otherwise the profile
      // looks like a browser with broken STUN (no srflx candidate at all)
      const webrtcPolicy =
        rt.webrtc === 'real' ? 'default' : rt.webrtc === 'disabled' ? 'disable_non_proxied_udp' : hasProxy(proxy) ? 'disable_non_proxied_udp' : 'default';
      const kernelPrepared = sunBrowser ? prepareSunBrowserProfile(userDataDir, { rt, profile, webrtcPolicy }) : null;
      if (!kernelPrepared) this.writePreferences(userDataDir, rt, profile);
      fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true });

      let args;
      if (kernelPrepared) {
        // the kernel reads its fingerprint from the profile files, not from CDP
        args = buildSunBrowserArgs({
          userDataDir,
          profile,
          rt,
          prepared: kernelPrepared,
          proxyArg: forwarder ? `http://127.0.0.1:${forwarder.port}` : null,
          webrtcPolicy,
          extraArgs,
        });
      } else {
        args = [
          `--user-data-dir=${userDataDir}`,
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-crash-restore-bubble',
          '--disable-search-engine-choice-screen',
        ];
        if (headless) args.push('--headless=new');
        if (forwarder) args.push(`--proxy-server=http://127.0.0.1:${forwarder.port}`);
        if (rt.languages) args.push(`--accept-lang=${rt.languages.join(',')}`);
        // service workers and the very first requests never see CDP overrides: set the UA globally too
        if (rt.userAgent && (headless || rt.customUserAgent || rt.os !== hostOS())) args.push(`--user-agent=${rt.userAgent}`);
        if (rt.screen && !headless) args.push(`--window-size=${Math.round(rt.screen.width * 0.8)},${Math.round(rt.screen.height * 0.8)}`);
        if (rt.screen && headless) args.push(`--window-size=${rt.screen.width},${rt.screen.height}`);
        for (const a of extraArgs) if (typeof a === 'string' && a.startsWith('--') && !BLOCKED_ARGS.test(a)) args.push(a);
        args.push('about:blank');
      }

      const env = { ...process.env };
      if (rt.timezone) env.TZ = rt.timezone;
      proc = spawn(browser.path, args, { stdio: ['ignore', 'ignore', 'pipe'], env, windowsHide: false });
      proc.stderr.on('data', (d) => {
        stderrBuf = (stderrBuf + d).slice(-4000);
      });
      const spawnError = new Promise((_, reject) => proc.once('error', (e) => reject(new Error(`无法启动浏览器: ${e.message}`))));
      spawnError.catch(() => {});
      const { port, wsPath } = await Promise.race([waitDevToolsPort(userDataDir, proc, 30000, () => stderrBuf), spawnError]);
      const wsEndpoint = `ws://127.0.0.1:${port}${wsPath}`;
      conn = await CDPConnection.connect(wsEndpoint);
      const controller = kernelPrepared
        ? new SunBrowserController(conn, rt, browser, { log: (m) => this.debugLog(id, m), uaOverride: this.kernelUA(rt, browser), langs: kernelPrepared.numbers?.langs, screen: rt.screen })
        : new FingerprintController(conn, rt, browser, { log: (m) => this.debugLog(id, m) });
      await controller.init();

      if (profile.pendingCookies?.length) {
        try {
          await conn.send('Storage.setCookies', { cookies: toCdpCookies(profile.pendingCookies) });
          this.store.patchProfile(id, { pendingCookies: [] }, { quiet: true });
        } catch (e) {
          this.debugLog(id, `cookie import failed: ${e.message}`);
        }
      }

      const inst = { id, proc, conn, controller, forwarder, browser, rt, ipInfo: geoInfo, port, wsEndpoint, startedAt: Date.now(), headless };
      this.running.set(id, inst);
      proc.once('exit', () => this.cleanup(id, inst));
      conn.once('close', () => setTimeout(() => proc.exitCode === null && proc.kill(), 3000));

      const urls = [];
      const serverUrl = this.getServerUrl();
      if (serverUrl && settings.showStartPage && ipTab !== false && !headless) urls.push(`${serverUrl}/start/${id}`);
      urls.push(...(openUrls || profile.startUrls || []));
      await controller.openTabs(urls);

      this.store.patchProfile(id, { lastOpenedAt: Date.now(), ...(ipInfo ? { lastIpInfo: ipInfo } : {}) });
      return this.info(id);
    } catch (err) {
      conn?.close();
      if (proc && proc.exitCode === null) proc.kill();
      await forwarder?.close();
      throw err;
    }
  }

  async cleanup(id, inst) {
    if (this.running.get(id) !== inst) return;
    this.running.delete(id);
    inst.conn.close();
    await inst.forwarder?.close().catch(() => {});
    this.store.patchProfile(id, { lastClosedAt: Date.now() }, { quiet: true });
    this.emitStatus(id);
  }

  stop(id) {
    return this.withLock(id, async () => {
      const inst = this.running.get(id);
      if (!inst) return false;
      await this.closeBrowser(inst.proc, inst.conn);
      await this.cleanup(id, inst);
      return true;
    });
  }

  async closeBrowser(proc, conn) {
    const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    conn?.send('Browser.close').catch(() => {});
    const ok = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
    if (!ok) {
      proc.kill();
      await Promise.race([exited, sleep(3000)]);
    }
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  /** A browser left running by a previous (crashed) run of this app keeps the profile locked. */
  async closeOrphan(userDataDir) {
    let port, wsPath;
    try {
      [port, wsPath] = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    } catch {
      return;
    }
    let conn;
    try {
      conn = await CDPConnection.connect(`ws://127.0.0.1:${port}${wsPath}`, { timeout: 1500 });
    } catch {
      return;
    }
    await conn.send('Browser.close').catch(() => {});
    conn.close();
    const lock = path.join(userDataDir, 'lockfile');
    for (let i = 0; i < 50 && fs.existsSync(lock); i++) await sleep(100);
    await sleep(300);
  }

  writePreferences(dir, rt, profile) {
    const file = path.join(dir, 'Default', 'Preferences');
    const prefs = readJson(file, {});
    setPath(prefs, 'profile.exit_type', 'Normal');
    setPath(prefs, 'profile.exited_cleanly', true);
    setPath(prefs, 'profile.name', `${profile.serial}-${profile.name}`.slice(0, 60));
    setPath(prefs, 'browser.has_seen_welcome_page', true);
    if (rt.languages) setPath(prefs, 'intl.accept_languages', rt.languages.join(','));
    const restrict = rt.webrtc !== 'real';
    setPath(prefs, 'webrtc.ip_handling_policy', restrict ? 'disable_non_proxied_udp' : undefined);
    setPath(prefs, 'webrtc.multiple_routes_enabled', restrict ? false : undefined);
    setPath(prefs, 'webrtc.nonproxied_udp_enabled', restrict ? false : undefined);
    writeFileAtomic(file, JSON.stringify(prefs));
  }

  /** Runs `fn(conn)` against the profile's browser, starting a temporary headless one if needed. */
  async withBrowser(id, fn) {
    const inst = this.running.get(id);
    if (inst) return fn(inst.conn);
    return this.withLock(id, async () => {
      const live = this.running.get(id);
      if (live) return fn(live.conn);
      const browser = resolveBrowser(this.store.settings.browserPath);
      const dir = this.profileDir(id);
      fs.mkdirSync(dir, { recursive: true });
      await this.closeOrphan(dir);
      fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true });
      const proc = spawn(browser.path, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      let conn;
      try {
        const { port, wsPath } = await waitDevToolsPort(dir, proc, 20000, () => err);
        conn = await CDPConnection.connect(`ws://127.0.0.1:${port}${wsPath}`);
        return await fn(conn);
      } finally {
        await this.closeBrowser(proc, conn);
        conn?.close();
      }
    });
  }

  async getCookies(id) {
    const { cookies } = await this.withBrowser(id, (conn) => conn.send('Storage.getCookies'));
    return fromCdpCookies(cookies);
  }

  /** Imports cookies now when the browser runs, else queues them for the next start. */
  async importCookies(id, cookies) {
    const inst = this.running.get(id);
    if (inst) {
      await inst.conn.send('Storage.setCookies', { cookies: toCdpCookies(cookies) });
      return { applied: cookies.length, queued: 0 };
    }
    const p = this.store.getProfile(id);
    const pending = [...(p.pendingCookies || []), ...cookies];
    this.store.patchProfile(id, { pendingCookies: pending }, { quiet: true });
    return { applied: 0, queued: cookies.length };
  }

  async clearCookies(id) {
    await this.withBrowser(id, (conn) => conn.send('Storage.clearCookies'));
  }

  removeProfileData(id) {
    if (this.running.has(id)) throw new Error('环境正在运行，请先关闭');
    rmrf(this.profileDir(id));
  }

  /**
   * The kernel's own UA-CH brands read "Chromium / Not A(Brand" because it is a Chromium build.
   * Rebuild them as Google Chrome, with the version taken from the UA string so everything agrees.
   */
  kernelUA(rt, browser) {
    const o = buildUAOverride(rt, browser, browser.version);
    if (!o || !o.userAgentMetadata) return null;
    const uaVersion = (rt.userAgent || '').match(/Chrome\/([\d.]+)/)?.[1] || `${browser.major}.0.0.0`;
    const major = uaVersion.split('.')[0];
    // real Google Chrome puts its own brand first and greases with "Not(A:Brand"; a plain
    // Chromium build (this kernel) reports "Chromium, … , Not A(Brand" instead — a dead giveaway
    o.userAgentMetadata = {
      ...o.userAgentMetadata,
      brands: [
        { brand: 'Google Chrome', version: major },
        { brand: 'Chromium', version: major },
        { brand: 'Not(A:Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: uaVersion },
        { brand: 'Chromium', version: uaVersion },
        { brand: 'Not(A:Brand', version: '24.0.0.0' },
      ],
      fullVersion: uaVersion,
      platformVersion: sanePlatformVersion(o.userAgentMetadata.platformVersion),
    };
    return o;
  }

  debugLog(id, msg) {
    if (this.debug) console.log(`[${id}] ${msg}`);
  }
}
