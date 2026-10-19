import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCompatApi } from './api-compat.js';
import { findBrowsers, resolveBrowser } from './browser-finder.js';
import { findSunBrowser } from './kernel-sunbrowser.js';
import { randomFingerprint, GPUS, SCREENS, TIMEZONES, LANGUAGE_PRESETS, OS_NAMES, hostOS } from './fingerprint.js';
import { normalizeProxy, parseProxyString, hasProxy } from './proxy-chain.js';
import { lookupIp } from './ipinfo.js';
import { parseCookies } from './cookies.js';
import { randomId } from './util.js';
import { renderStartPage } from './start-page.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', 'local.adspower.net']);

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, re, keys, handler });
  }
  alias(method, pattern, fromMethod) {
    const r = this.routes.find((x) => x.pattern === pattern && x.method === fromMethod);
    this.routes.push({ ...r, method });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(text)));
        else reject(new Error('请求体不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Rejects requests that a web page could have forged: wrong Host (DNS rebinding) or a
 * cross-site browser request (CSRF against the local API). Scripts/SDKs send neither header.
 */
function rejectForeign(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!ALLOWED_HOSTS.has(hostname)) return 'host not allowed';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request blocked';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return 'cross-origin request blocked';
    } catch {
      return 'invalid origin';
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { id: items[idx], ok: true, data: await fn(items[idx]) };
      } catch (e) {
        results[idx] = { id: items[idx], ok: false, error: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createServer({ store, launcher, profiles, getBaseUrl }) {
  const router = new Router();
  const sseClients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  launcher.on('status', (s) => broadcast('status', s));
  let pending = null;
  const notify = (what) => {
    pending ||= new Set();
    pending.add(what);
    setTimeout(() => {
      if (!pending) return;
      for (const w of pending) broadcast(w, {});
      pending = null;
    }, 50);
  };
  store.on('profiles', () => notify('profiles'));
  store.on('groups', () => notify('groups'));
  const ping = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 20000);
  ping.unref();

  const systemInfo = () => {
    let resolved = null;
    let error = null;
    try {
      resolved = resolveBrowser(store.settings.browserPath);
    } catch (e) {
      error = e.message;
    }
    return {
      browsers: findBrowsers(),
      browser: resolved,
      browserError: error,
      sunBrowser: findSunBrowser(store.settings.sunBrowserPath),
      hostOS: hostOS(),
      dataDir: launcher.dataDir,
      apiBase: getBaseUrl(),
    };
  };

  const ids = (b) => {
    const list = Array.isArray(b?.ids) ? b.ids.map(String) : [];
    if (!list.length) throw new Error('请选择环境');
    return list;
  };

  // ------------------------------------------------------------ internal API (used by the UI)
  const api = (method, p, fn) =>
    router.add(method, `/internal${p}`, async (ctx) => {
      try {
        const data = await fn(ctx);
        return { ok: true, data };
      } catch (e) {
        return { __status: 400, ok: false, error: e.message };
      }
    });

  api('GET', '/bootstrap', () => ({
    profiles: profiles.list(),
    groups: store.listGroups(),
    settings: store.settings,
    system: systemInfo(),
    running: [...launcher.running.keys()].map((id) => launcher.info(id)),
    presets: { gpus: GPUS, screens: SCREENS, timezones: TIMEZONES, languages: LANGUAGE_PRESETS, os: OS_NAMES },
  }));
  api('GET', '/profiles', ({ query }) => profiles.list({ groupId: query.groupId, q: query.q }));
  api('GET', '/profiles/:id', ({ params }) => {
    const p = profiles.get(params.id);
    return { ...profiles.view(p), runtime: launcher.info(p.id) };
  });
  api('POST', '/profiles', ({ body }) => profiles.create(body || {}));
  api('POST', '/profiles/batch', ({ body }) => profiles.batchCreate(body || {}));
  api('PUT', '/profiles/:id', ({ params, body }) => profiles.update(params.id, body || {}));
  api('POST', '/profiles/delete', async ({ body }) => ({ deleted: await profiles.remove(ids(body)) }));
  api('POST', '/profiles/move', ({ body }) => profiles.move(ids(body), body.groupId));
  api('POST', '/profiles/start', ({ body }) => mapLimit(ids(body), 3, (id) => launcher.start(id, { headless: !!body.headless })));
  api('POST', '/profiles/stop', ({ body }) => mapLimit(ids(body), 5, (id) => launcher.stop(id)));
  api('POST', '/profiles/stop-all', () => launcher.stopAll());
  api('POST', '/profiles/:id/start', ({ params, body }) => launcher.start(params.id, { headless: !!body?.headless }));
  api('POST', '/profiles/:id/stop', ({ params }) => launcher.stop(params.id));
  api('POST', '/profiles/:id/clone', ({ params }) => {
    const src = profiles.get(params.id);
    return profiles.create({ ...structuredClone(src), name: `${src.name} 副本`, fingerprint: { ...randomFingerprint(src.fingerprint.os, src.fingerprint), os: src.fingerprint.os }, cookies: undefined });
  });
  api('GET', '/profiles/:id/cookies', ({ params }) => launcher.getCookies(profiles.get(params.id).id));
  api('POST', '/profiles/:id/cookies', ({ params, body }) => launcher.importCookies(profiles.get(params.id).id, parseCookies(body?.cookies)));
  api('DELETE', '/profiles/:id/cookies', async ({ params }) => {
    const p = profiles.get(params.id);
    store.patchProfile(p.id, { pendingCookies: [] }, { quiet: true });
    await launcher.clearCookies(p.id);
  });

  api('GET', '/fingerprint/random', ({ query }) => randomFingerprint(query.os || hostOS(), { screen: { mode: query.screen === 'custom' ? 'custom' : 'real' } }));
  api('POST', '/proxy/parse', ({ body }) => {
    const p = parseProxyString(body?.text, body?.type);
    if (!p) throw new Error('无法识别的代理格式');
    return p;
  });
  api('POST', '/proxy/check', async ({ body }) => {
    const proxy = body?.text ? parseProxyString(body.text, body.type) : normalizeProxy(body?.proxy);
    if (!proxy) throw new Error('无法识别的代理格式');
    if (proxy.type !== 'none' && !hasProxy(proxy)) throw new Error('请填写代理主机和端口');
    const t0 = Date.now();
    const info = await lookupIp(proxy);
    return { ...info, latency: Date.now() - t0 };
  });

  api('GET', '/groups', () => store.listGroups());
  api('POST', '/groups', ({ body }) => {
    const name = String(body?.name || '').trim();
    if (!name) throw new Error('分组名称不能为空');
    if (store.listGroups().some((g) => g.name === name)) throw new Error('分组名称已存在');
    return store.insertGroup({ id: randomId(6), name, remark: String(body.remark || ''), createdAt: Date.now() });
  });
  api('PUT', '/groups/:id', ({ params, body }) => {
    const fields = {};
    if (body?.name !== undefined) {
      fields.name = String(body.name).trim();
      if (!fields.name) throw new Error('分组名称不能为空');
      if (store.listGroups().some((g) => g.name === fields.name && g.id !== params.id)) throw new Error('分组名称已存在');
    }
    if (body?.remark !== undefined) fields.remark = String(body.remark);
    return store.updateGroup(params.id, fields);
  });
  api('DELETE', '/groups/:id', ({ params }) => store.deleteGroup(params.id));

  api('GET', '/settings', () => store.settings);
  api('PUT', '/settings', ({ body }) => {
    if (body?.browserPath) resolveBrowser(body.browserPath);
    store.updateSettings(body || {});
    return { settings: store.settings, system: systemInfo() };
  });
  api('GET', '/system', () => systemInfo());

  // ------------------------------------------------------------ AdsPower compatible API
  registerCompatApi(router, { store, launcher, profiles });

  // ------------------------------------------------------------ HTTP server
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const { pathname } = url;
    const foreign = rejectForeign(req);
    if (foreign) {
      sendJson(res, 403, { code: -1, ok: false, msg: foreign, error: foreign });
      return;
    }

    if (pathname === '/internal/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/') && store.settings.apiKey) {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (auth !== store.settings.apiKey && url.searchParams.get('api_key') !== store.settings.apiKey) {
        sendJson(res, 200, { code: -1, msg: 'api key is invalid' });
        return;
      }
    }

    const match = router.match(req.method, pathname);
    if (match) {
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await readBody(req);
        } catch (e) {
          sendJson(res, 400, { code: -1, ok: false, msg: e.message, error: e.message });
          return;
        }
      }
      const result = await match.handler({ req, res, params: match.params, query: Object.fromEntries(url.searchParams), body });
      if (res.headersSent) return;
      const status = result?.__status || 200;
      if (result) delete result.__status;
      sendJson(res, status, result ?? { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/start/')) {
      const id = decodeURIComponent(pathname.slice('/start/'.length));
      const p = store.getProfile(id);
      if (!p) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderStartPage(p, launcher.info(id), store.getGroup(p.groupId)));
      return;
    }

    if (req.method === 'GET') {
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    sendJson(res, 404, { code: -1, ok: false, msg: 'not found', error: 'not found' });
  });

  server.on('close', () => {
    clearInterval(ping);
    for (const res of sseClients) res.end();
  });
  return server;
}
