import { normalizeFingerprint, randomFingerprint, hostOS } from './fingerprint.js';
import { normalizeProxy, parseProxyString } from './proxy-chain.js';
import { parseCookies } from './cookies.js';
import { DEFAULT_GROUP_ID } from './store.js';
import { randomId } from './util.js';

function normalizeUrls(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/\r?\n/);
  return list
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((s) => (/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`))
    .slice(0, 20);
}

/** Profile CRUD with validation; the store only persists. */
export class ProfileService {
  constructor(store, launcher) {
    this.store = store;
    this.launcher = launcher;
  }

  view(p) {
    const { pendingCookies, ...rest } = p;
    return { ...rest, pendingCookieCount: pendingCookies?.length || 0, status: this.launcher.status(p.id) };
  }

  list({ groupId, q, ids } = {}) {
    let list = this.store.listProfiles();
    if (groupId !== undefined && groupId !== '' && groupId !== null) list = list.filter((p) => p.groupId === String(groupId));
    if (ids) {
      const set = new Set(ids);
      list = list.filter((p) => set.has(p.id));
    }
    if (q) {
      const s = String(q).toLowerCase();
      list = list.filter((p) =>
        [p.name, p.remark, p.id, String(p.serial), p.proxy?.host, p.lastIpInfo?.ip].some((v) => v && String(v).toLowerCase().includes(s)),
      );
    }
    return [...list].sort((a, b) => b.serial - a.serial).map((p) => this.view(p));
  }

  get(id) {
    const p = this.store.getProfile(id);
    if (!p) throw new Error(`环境不存在: ${id}`);
    return p;
  }

  /** Builds a validated profile from user input, on top of `base` for updates. */
  normalize(input, base) {
    const p = base
      ? structuredClone(base)
      : {
          id: randomId(),
          serial: this.store.takeSerial(),
          name: '',
          groupId: DEFAULT_GROUP_ID,
          remark: '',
          startUrls: [],
          proxy: normalizeProxy(null),
          fingerprint: null,
          pendingCookies: [],
          createdAt: Date.now(),
          lastOpenedAt: null,
        };
    if (input.name !== undefined) p.name = String(input.name).trim().slice(0, 100);
    if (!p.name) p.name = `环境 ${p.serial}`;
    if (input.groupId !== undefined) p.groupId = this.store.getGroup(input.groupId) ? String(input.groupId) : DEFAULT_GROUP_ID;
    if (input.remark !== undefined) p.remark = String(input.remark).slice(0, 1000);
    if (input.startUrls !== undefined) p.startUrls = normalizeUrls(input.startUrls);
    if (input.proxyString) {
      const parsed = parseProxyString(input.proxyString, input.proxy?.type && input.proxy.type !== 'none' ? input.proxy.type : 'http');
      if (!parsed) throw new Error(`无法识别的代理: ${input.proxyString}`);
      p.proxy = parsed;
    } else if (input.proxy !== undefined) {
      p.proxy = normalizeProxy(input.proxy);
      if (p.proxy.type !== 'none' && (!p.proxy.host || !p.proxy.port)) throw new Error('代理主机和端口不能为空');
    }
    if (input.fingerprint !== undefined || !p.fingerprint) {
      p.fingerprint = normalizeFingerprint(input.fingerprint || {}, p.fingerprint || randomFingerprint(input.fingerprint?.os || hostOS()));
    }
    if (input.cookies !== undefined && input.cookies !== null && input.cookies !== '') p.pendingCookies = parseCookies(input.cookies);
    p.updatedAt = Date.now();
    return p;
  }

  create(input = {}) {
    const p = this.normalize(input, null);
    this.store.insertProfile(p);
    return this.view(p);
  }

  update(id, input = {}) {
    const p = this.normalize(input, this.get(id));
    if (p.proxy && JSON.stringify(p.proxy) !== JSON.stringify(this.get(id).proxy)) delete p.lastIpInfo;
    this.store.replaceProfile(p);
    return this.view(p);
  }

  /** Creates `count` profiles with random fingerprints; one proxy per line is assigned in order. */
  batchCreate({ count, groupId, namePrefix, proxies, os, proxyType } = {}) {
    const lines = String(proxies || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = lines.map((l) => {
      const p = parseProxyString(l, proxyType || 'http');
      if (!p) throw new Error(`无法识别的代理: ${l}`);
      return p;
    });
    const n = Math.min(Math.max(Number(count) || parsed.length || 1, 1), 500);
    const created = [];
    for (let i = 0; i < n; i++) {
      const serial = this.store.data.nextSerial;
      created.push(
        this.create({
          name: namePrefix ? `${namePrefix}${i + 1}` : `环境 ${serial}`,
          groupId,
          proxy: parsed.length ? parsed[i % parsed.length] : undefined,
          fingerprint: randomFingerprint(os || hostOS()),
        }),
      );
    }
    return created;
  }

  async remove(ids) {
    for (const id of ids) {
      await this.launcher.stop(id).catch(() => {});
      try {
        this.launcher.removeProfileData(id);
      } catch {}
    }
    return this.store.deleteProfiles(ids);
  }

  move(ids, groupId) {
    const gid = this.store.getGroup(groupId) ? String(groupId) : DEFAULT_GROUP_ID;
    for (const id of ids) this.store.patchProfile(id, { groupId: gid }, { quiet: true });
    this.store.emit('profiles');
  }
}
