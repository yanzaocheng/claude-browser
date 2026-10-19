/**
 * Subset of the AdsPower Local API (http://local.adspower.net:50325/api/v1/...), so scripts
 * written for AdsPower (Puppeteer / Playwright / Selenium) work unchanged.
 */
import { DEFAULT_GROUP_ID } from './store.js';
import { randomId } from './util.js';

const ok = (data, msg = 'success') => (data === undefined ? { code: 0, msg } : { code: 0, msg, data });
const unixSec = (ms) => (ms ? String(Math.floor(ms / 1000)) : '0');

const OS_FROM_SYSTEM = (s) => {
  s = String(s || '').toLowerCase();
  if (s.includes('mac')) return 'macos';
  if (s.includes('linux') || s.includes('ubuntu')) return 'linux';
  if (s.includes('win')) return 'windows';
  return undefined;
};

const flag = (v) => (v === undefined || v === null || v === '' ? undefined : String(v) === '1' || v === true);

/** AdsPower create/update body -> our profile input. */
export function fromAdsInput(body = {}) {
  const out = {};
  if (body.name !== undefined) out.name = body.name;
  if (body.group_id !== undefined) out.groupId = String(body.group_id);
  if (body.remark !== undefined) out.remark = body.remark;
  if (Array.isArray(body.open_urls)) out.startUrls = body.open_urls;
  else if (body.domain_name) out.startUrls = [body.domain_name];
  if (body.cookie) out.cookies = typeof body.cookie === 'string' ? body.cookie : JSON.stringify(body.cookie);
  const pc = body.user_proxy_config;
  if (pc) {
    if (pc.proxy_soft === 'no_proxy' || !pc.proxy_host) out.proxy = { type: 'none' };
    else {
      out.proxy = {
        type: String(pc.proxy_type || 'http').toLowerCase(),
        host: pc.proxy_host,
        port: pc.proxy_port,
        username: pc.proxy_user || '',
        password: pc.proxy_password || '',
      };
    }
  }
  const fc = body.fingerprint_config;
  if (fc) {
    const fp = {};
    const os = OS_FROM_SYSTEM(fc.random_ua?.ua_system_version?.[0]);
    if (os) fp.os = os;
    if (fc.ua) fp.userAgent = fc.ua;
    if (flag(fc.automatic_timezone) === true) fp.timezone = { mode: 'ip' };
    else if (fc.timezone) fp.timezone = { mode: 'custom', value: fc.timezone };
    if (flag(fc.language_switch) === true) fp.language = { mode: 'ip' };
    else if (Array.isArray(fc.language) && fc.language.length) fp.language = { mode: 'custom', value: fc.language.join(',') };
    if (fc.screen_resolution) {
      const m = String(fc.screen_resolution).match(/^(\d+)[_x*](\d+)$/);
      fp.screen = m ? { mode: 'custom', width: Number(m[1]), height: Number(m[2]) } : { mode: 'real' };
    }
    if (fc.hardware_concurrency !== undefined) fp.hardwareConcurrency = Number(fc.hardware_concurrency) || 0;
    if (fc.device_memory !== undefined) fp.deviceMemory = Number(fc.device_memory) || 0;
    if (fc.webrtc) fp.webrtc = { forward: 'proxy', proxy: 'proxy', local: 'real', real: 'real', disabled: 'disabled' }[fc.webrtc] || 'proxy';
    for (const [k, ours] of [['canvas', 'canvas'], ['webgl_image', 'webglImage'], ['audio', 'audio'], ['client_rects', 'clientRects']]) {
      const f = flag(fc[k]);
      if (f !== undefined) fp[ours] = f ? 'noise' : 'real';
    }
    if (fc.webgl_config?.unmasked_vendor && fc.webgl_config?.unmasked_renderer) {
      fp.webgl = { mode: 'custom', vendor: fc.webgl_config.unmasked_vendor, renderer: fc.webgl_config.unmasked_renderer };
    } else if (String(fc.webgl) === '0') fp.webgl = { mode: 'real' };
    if (fc.location || fc.location_switch !== undefined) {
      fp.geolocation = { permission: ['ask', 'allow', 'block'].includes(fc.location) ? fc.location : 'ask' };
      if (flag(fc.location_switch) === false && fc.latitude !== undefined) {
        Object.assign(fp.geolocation, { mode: 'custom', latitude: fc.latitude, longitude: fc.longitude, accuracy: fc.accuracy || 100 });
      } else fp.geolocation.mode = 'ip';
    }
    out.fingerprint = fp;
  }
  return out;
}

function toAdsUser(p, store) {
  return {
    serial_number: String(p.serial),
    user_id: p.id,
    name: p.name,
    group_id: p.groupId,
    group_name: store.getGroup(p.groupId)?.name || '',
    domain_name: p.startUrls?.[0] || '',
    username: '',
    remark: p.remark || '',
    created_time: unixSec(p.createdAt),
    ip: p.lastIpInfo?.ip || '',
    ip_country: (p.lastIpInfo?.countryCode || '').toLowerCase(),
    password: '',
    last_open_time: unixSec(p.lastOpenedAt),
  };
}

function wsInfo(info, settings) {
  return {
    ws: { selenium: `127.0.0.1:${info.debugPort}`, puppeteer: info.ws },
    debug_port: String(info.debugPort),
    webdriver: settings.chromedriverPath || '',
  };
}

export function registerCompatApi(router, { store, launcher, profiles }) {
  const resolveId = (q) => {
    if (q.user_id) {
      if (!store.getProfile(q.user_id)) throw new Error(`user_id is invalid: ${q.user_id}`);
      return q.user_id;
    }
    if (q.serial_number) {
      const p = store.getProfileBySerial(q.serial_number);
      if (!p) throw new Error(`serial_number is invalid: ${q.serial_number}`);
      return p.id;
    }
    throw new Error('user_id or serial_number is required');
  };
  const route = (method, path, fn) =>
    router.add(method, path, async (ctx) => {
      try {
        return await fn({ ...ctx.query, ...(ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) }, ctx);
      } catch (e) {
        return { code: -1, msg: e.message };
      }
    });

  router.add('GET', '/status', async () => ok(undefined));

  route('GET', '/api/v1/browser/start', async (q) => {
    const id = resolveId(q);
    let extraArgs = [];
    if (q.launch_args) {
      try {
        extraArgs = typeof q.launch_args === 'string' ? JSON.parse(q.launch_args) : q.launch_args;
      } catch {
        throw new Error('launch_args must be a JSON array');
      }
    }
    const info = await launcher.start(id, {
      headless: flag(q.headless) === true,
      ipTab: flag(q.ip_tab) !== false,
      openUrls: flag(q.open_tabs) === true ? [] : undefined,
      extraArgs: Array.isArray(extraArgs) ? extraArgs : [],
    });
    return ok(wsInfo(info, store.settings));
  });
  router.alias('POST', '/api/v1/browser/start', 'GET');

  route('GET', '/api/v1/browser/stop', async (q) => {
    await launcher.stop(resolveId(q));
    return ok(undefined);
  });
  router.alias('POST', '/api/v1/browser/stop', 'GET');

  route('GET', '/api/v1/browser/active', async (q) => {
    const info = launcher.info(resolveId(q));
    return ok(info ? { status: 'Active', ...wsInfo(info, store.settings) } : { status: 'Inactive' });
  });

  route('GET', '/api/v1/browser/local-active', async () => {
    const list = [...launcher.running.keys()].map((id) => ({ user_id: id, ...wsInfo(launcher.info(id), store.settings) }));
    return ok({ list });
  });

  route('POST', '/api/v1/user/create', async (b) => {
    if (b.group_id === undefined) b.group_id = DEFAULT_GROUP_ID;
    const p = profiles.create(fromAdsInput(b));
    return ok({ id: p.id, serial_number: String(p.serial) });
  });

  route('POST', '/api/v1/user/update', async (b) => {
    if (!b.user_id) throw new Error('user_id is required');
    profiles.update(resolveId(b), fromAdsInput(b));
    return ok(undefined);
  });

  route('POST', '/api/v1/user/delete', async (b) => {
    const ids = Array.isArray(b.user_ids) ? b.user_ids : [];
    if (!ids.length) throw new Error('user_ids is required');
    await profiles.remove(ids.filter((id) => store.getProfile(id)));
    return ok(undefined);
  });

  route('POST', '/api/v1/user/regroup', async (b) => {
    if (!store.getGroup(b.group_id)) throw new Error('group_id is invalid');
    profiles.move(b.user_ids || [], b.group_id);
    return ok(undefined);
  });

  route('GET', '/api/v1/user/list', async (q) => {
    const page = Math.max(1, Number(q.page) || 1);
    const size = Math.min(100, Math.max(1, Number(q.page_size) || 50));
    let list = profiles.list({ groupId: q.group_id });
    if (q.user_id) list = list.filter((p) => p.id === q.user_id);
    if (q.serial_number) list = list.filter((p) => String(p.serial) === String(q.serial_number));
    const items = list.slice((page - 1) * size, page * size).map((p) => toAdsUser(store.getProfile(p.id), store));
    return ok({ list: items, page, page_size: size });
  });

  const groupList = async (q) => {
    const page = Math.max(1, Number(q.page) || 1);
    const size = Math.min(2000, Math.max(1, Number(q.page_size) || 50));
    let list = store.listGroups();
    if (q.group_name) list = list.filter((g) => g.name.includes(q.group_name));
    return ok({ list: list.slice((page - 1) * size, page * size).map((g) => ({ group_id: g.id, group_name: g.name, remark: g.remark || '' })), page, page_size: size });
  };
  route('GET', '/api/v1/group/list', groupList);
  route('GET', '/api/v1/group/query', groupList);

  route('POST', '/api/v1/group/create', async (b) => {
    const name = String(b.group_name || '').trim();
    if (!name) throw new Error('group_name is required');
    if (store.listGroups().some((g) => g.name === name)) throw new Error('group_name already exists');
    const g = store.insertGroup({ id: randomId(6), name, remark: String(b.remark || ''), createdAt: Date.now() });
    return ok({ group_id: g.id, group_name: g.name, remark: g.remark });
  });

  route('POST', '/api/v1/group/update', async (b) => {
    if (!store.getGroup(b.group_id)) throw new Error('group_id is invalid');
    const fields = {};
    if (b.group_name) fields.name = String(b.group_name);
    if (b.remark !== undefined) fields.remark = String(b.remark);
    store.updateGroup(b.group_id, fields);
    return ok(undefined);
  });
}
