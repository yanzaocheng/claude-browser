import { EventEmitter } from 'node:events';
import { readJson, writeFileAtomic } from './util.js';

export const DEFAULT_GROUP_ID = '0';

const DEFAULT_SETTINGS = {
  browserPath: '', // empty = auto detect Chrome / Edge
  kernel: '', // '' | 'sunbrowser' — sunbrowser = AdsPower kernel with native fingerprint
  sunBrowserPath: '', // empty = auto detect %APPDATA%\adspower_global\cwd_global\chrome_*\sunbrowser.exe
  showStartPage: true, // open the local start page (IP + fingerprint summary) as the first tab
  shell: 'auto', // management window host: auto | edge | chrome | browser
  apiKey: '', // optional key required by the /api/v1 automation API
  chromedriverPath: '', // returned as `webdriver` by /api/v1/browser/start (Selenium)
};

/** JSON-file database. Small enough to keep fully in memory and rewrite on change. */
export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    const data = readJson(file, null) || {};
    this.data = {
      version: 1,
      nextSerial: data.nextSerial || 1,
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      groups: Array.isArray(data.groups) ? data.groups : [],
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    };
    if (!this.data.groups.some((g) => g.id === DEFAULT_GROUP_ID)) {
      this.data.groups.unshift({ id: DEFAULT_GROUP_ID, name: '未分组', remark: '', createdAt: Date.now() });
    }
    this.save();
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  // ---- profiles
  listProfiles() {
    return this.data.profiles;
  }
  getProfile(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }
  getProfileBySerial(serial) {
    return this.data.profiles.find((p) => p.serial === Number(serial)) || null;
  }
  takeSerial() {
    return this.data.nextSerial++;
  }
  insertProfile(profile) {
    this.data.profiles.push(profile);
    this.save();
    this.emit('profiles');
    return profile;
  }
  replaceProfile(profile) {
    const i = this.data.profiles.findIndex((p) => p.id === profile.id);
    if (i < 0) throw new Error(`环境不存在: ${profile.id}`);
    this.data.profiles[i] = profile;
    this.save();
    this.emit('profiles');
    return profile;
  }
  /** Shallow-merges fields into a profile without emitting a full refresh when quiet. */
  patchProfile(id, fields, { quiet = false } = {}) {
    const p = this.getProfile(id);
    if (!p) return null;
    Object.assign(p, fields);
    this.save();
    if (!quiet) this.emit('profiles');
    return p;
  }
  deleteProfiles(ids) {
    const set = new Set(ids);
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter((p) => !set.has(p.id));
    this.save();
    this.emit('profiles');
    return before - this.data.profiles.length;
  }

  // ---- groups
  listGroups() {
    return this.data.groups;
  }
  getGroup(id) {
    return this.data.groups.find((g) => g.id === String(id)) || null;
  }
  insertGroup(group) {
    this.data.groups.push(group);
    this.save();
    this.emit('groups');
    return group;
  }
  updateGroup(id, fields) {
    const g = this.getGroup(id);
    if (!g) throw new Error('分组不存在');
    Object.assign(g, fields);
    this.save();
    this.emit('groups');
    return g;
  }
  deleteGroup(id) {
    if (id === DEFAULT_GROUP_ID) throw new Error('默认分组不能删除');
    if (!this.getGroup(id)) throw new Error('分组不存在');
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    for (const p of this.data.profiles) if (p.groupId === id) p.groupId = DEFAULT_GROUP_ID;
    this.save();
    this.emit('groups');
    this.emit('profiles');
  }

  // ---- settings
  get settings() {
    return this.data.settings;
  }
  updateSettings(fields) {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in fields) this.data.settings[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!fields[k] : String(fields[k] ?? '').trim();
    }
    this.save();
    return this.data.settings;
  }
}
