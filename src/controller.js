import { buildScript } from './inject/spoof.js';
import { buildUAOverride, buildUserAgent, clientHintHeaders, hostOS } from './fingerprint.js';

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const WORKERS = new Set(['worker', 'shared_worker', 'service_worker']);

/**
 * Keeps one CDP connection to a profile's browser and applies the fingerprint to every target
 * the moment it is created: new targets are paused (waitForDebuggerOnStart) until the overrides
 * and the init script are in place, so no site script ever runs unpatched.
 */
export class FingerprintController {
  constructor(conn, rt, browser, { log } = {}) {
    this.conn = conn;
    this.rt = rt;
    this.browser = browser;
    this.log = log || (() => {});
    this.ready = new Map(); // targetId -> { promise, resolve }
    this.pageSessions = new Map(); // targetId -> page session
  }

  async init() {
    const { conn, rt, browser } = this;
    const version = await conn.send('Browser.getVersion');
    const fullVersion = version.product.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] || browser.version || '';
    this.fullVersion = fullVersion;
    if (!rt.userAgent) {
      rt.major = Number(fullVersion.split('.')[0]);
      rt.userAgent = buildUserAgent(rt.os, rt.major, browser.kind);
    }
    this.uaOverride = buildUAOverride(rt, browser, fullVersion);
    // navigator.platform needs a JS patch only when it differs from the real one
    const spoof = { ...rt.spoof, platform: rt.os !== hostOS() || rt.customUserAgent ? rt.navPlatform : undefined };
    this.pageScript = buildScript(spoof);
    this.workerScript = buildScript({
      ...spoof,
      worker: {
        hardwareConcurrency: rt.hardwareConcurrency,
        userAgent: rt.userAgent,
        appVersion: rt.userAgent.replace(/^Mozilla\//, ''),
      },
    });

    conn.on('attached', (session, params) => {
      this.onAttached(session, params).catch((e) => this.log(`attach ${params.targetInfo.type}: ${e.message}`));
    });

    // Browser-initiated navigations (new tabs, noopener links) send their first request before a
    // new target can be paused and overridden. Intercept document requests browser-wide and give
    // them the spoofed UA / client-hint headers.
    if (this.uaOverride) {
      this.headerValues = clientHintHeaders(this.uaOverride);
      conn.on('Fetch.requestPaused', (e) => this.onRequestPaused(e));
      await conn.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }).catch((e) => this.log(`Fetch.enable: ${e.message}`));
    }

    await conn.send('Target.setAutoAttach', AUTO_ATTACH);

    if (rt.geoPermission === 'block') {
      await conn.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied' }).catch(() => {});
    } else if (rt.geoPermission === 'allow' && rt.geolocation) {
      await conn.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted' }).catch(() => {});
    }
  }

  onRequestPaused(e) {
    const headers = [];
    for (const [name, value] of Object.entries(e.request.headers || {})) {
      const v = this.headerValues[name.toLowerCase()];
      headers.push({ name, value: v === undefined ? value : v });
    }
    this.conn.send('Fetch.continueRequest', { requestId: e.requestId, headers }).catch(() => {
      this.conn.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    });
  }

  waitReady(targetId) {
    let r = this.ready.get(targetId);
    if (!r) {
      let resolve;
      const promise = new Promise((res) => (resolve = res));
      r = { promise, resolve };
      this.ready.set(targetId, r);
    }
    return r.promise;
  }

  async onAttached(s, { targetInfo: t, waitingForDebugger }) {
    let tasks = [];
    try {
      if (t.type === 'page' || t.type === 'iframe') {
        tasks = this.pageTasks(s);
        if (t.type === 'page') {
          this.pageSessions.set(t.targetId, s);
          s.once('detached', () => {
            this.pageSessions.delete(t.targetId);
            this.ready.delete(t.targetId);
            this.reapplyProcessWide();
          });
        }
      } else if (WORKERS.has(t.type) && !/^chrome(-extension)?:/.test(t.url)) {
        tasks = this.workerTasks(s);
      } else if (t.type === 'tab') {
        tasks = [s.send('Target.setAutoAttach', AUTO_ATTACH)];
      }
    } catch (e) {
      this.log(`${t.type}: ${e.message}`);
    }
    // Resume right away instead of awaiting the overrides: commands on a session are processed in
    // order, so they still land before the target runs. Awaiting would deadlock targets whose
    // renderer only starts after resuming (e.g. noopener popups).
    const resumed = waitingForDebugger ? s.send('Runtime.runIfWaitingForDebugger').catch(() => {}) : null;
    const results = await Promise.allSettled(tasks);
    await resumed;
    for (const r of results) {
      if (r.status === 'rejected' && !/already in effect|detached|closed/.test(r.reason.message)) this.log(`${t.type} ${t.url}: ${r.reason.message}`);
    }
    if (t.type === 'page') {
      this.waitReady(t.targetId);
      this.ready.get(t.targetId).resolve(s);
    }
  }

  /**
   * Timezone and locale overrides are per renderer process and owned by the session that set
   * them; pages sharing a process got "already in effect". When the owner closes, the override
   * would vanish for the others, so every remaining page sets it again.
   */
  reapplyProcessWide() {
    clearTimeout(this.reapplyTimer);
    this.reapplyTimer = setTimeout(() => {
      const { rt } = this;
      for (const s of this.pageSessions.values()) {
        if (rt.timezone) s.send('Emulation.setTimezoneOverride', { timezoneId: rt.timezone }).catch(() => {});
        if (rt.languages) s.send('Emulation.setLocaleOverride', { locale: rt.languages[0] }).catch(() => {});
      }
    }, 50);
  }

  pageTasks(s) {
    const { rt } = this;
    const tasks = [
      // init scripts only run in documents of frames whose Page domain is enabled
      s.send('Page.enable'),
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: this.pageScript, runImmediately: true }),
      s.send('Target.setAutoAttach', AUTO_ATTACH),
    ];
    if (this.uaOverride) tasks.push(this.setUA(s, 'Emulation.setUserAgentOverride'));
    if (rt.timezone) tasks.push(s.send('Emulation.setTimezoneOverride', { timezoneId: rt.timezone }));
    if (rt.languages) tasks.push(s.send('Emulation.setLocaleOverride', { locale: rt.languages[0] }));
    if (rt.geolocation) tasks.push(s.send('Emulation.setGeolocationOverride', rt.geolocation));
    if (rt.hardwareConcurrency) tasks.push(s.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: rt.hardwareConcurrency }));
    // native, so CSS @media (color-gamut) agrees with matchMedia
    if (rt.colorGamut) tasks.push(s.send('Emulation.setEmulatedMedia', { features: [{ name: 'color-gamut', value: rt.colorGamut }] }));
    if (rt.screen) {
      // width/height 0 keep the real viewport (it follows the window); only the screen is overridden
      tasks.push(
        s.send('Emulation.setDeviceMetricsOverride', {
          width: 0,
          height: 0,
          deviceScaleFactor: 0,
          mobile: false,
          screenWidth: rt.screen.width,
          screenHeight: rt.screen.height,
        }),
      );
    }
    return tasks;
  }

  workerTasks(s) {
    const tasks = [s.send('Runtime.evaluate', { expression: this.workerScript, silent: true }), s.send('Target.setAutoAttach', AUTO_ATTACH)];
    if (this.uaOverride) tasks.push(this.setUA(s, 'Network.setUserAgentOverride'));
    return tasks;
  }

  async setUA(s, method) {
    try {
      await s.send(method, this.uaOverride);
    } catch (e) {
      // older browsers reject unknown metadata fields
      const { formFactors, ...meta } = this.uaOverride.userAgentMetadata;
      await s.send(method, { ...this.uaOverride, userAgentMetadata: meta });
    }
  }

  /** Navigates the initial blank tab to the first URL and opens the others in new tabs. */
  async openTabs(urls) {
    const { conn } = this;
    const { targetInfos } = await conn.send('Target.getTargets');
    const first = targetInfos.find((t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''));
    const list = urls.filter(Boolean);
    if (!list.length) list.push('about:blank');
    let rest = list;
    if (first) {
      const s = await Promise.race([this.waitReady(first.targetId), new Promise((r) => setTimeout(r, 5000))]);
      if (s && list[0] !== 'about:blank') await s.send('Page.navigate', { url: list[0] }).catch(() => {});
      rest = list.slice(1);
    }
    // Target.createTarget({url}) sends the first request before the target can be paused, so
    // open blank tabs, let them be set up, then navigate
    for (const url of rest) {
      try {
        // background: the first tab (start page or first URL) stays in front
        const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: !!first });
        const s = await Promise.race([this.waitReady(targetId), new Promise((r) => setTimeout(r, 5000))]);
        if (s && url !== 'about:blank') await s.send('Page.navigate', { url });
      } catch {}
    }
    // targets restored from a previous session loaded before we attached: reload them patched
    for (const t of targetInfos) {
      if (t.type !== 'page' || t === first || /^(about|chrome|edge|devtools|chrome-extension):/.test(t.url)) continue;
      const s = await Promise.race([this.waitReady(t.targetId), new Promise((r) => setTimeout(r, 3000))]);
      if (s) await s.send('Page.reload').catch(() => {});
    }
  }
}
