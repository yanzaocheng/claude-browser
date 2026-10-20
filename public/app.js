// Claude Browser management UI (no build step, no dependencies).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j.data;
}

const state = {
  profiles: [],
  groups: [],
  settings: {},
  system: {},
  presets: {},
  running: new Map(), // id -> runtime info
  status: new Map(), // id -> running | starting | stopped
  selected: new Set(),
  filter: { groupId: '', q: '' },
  page: 'profiles',
};

const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

// ------------------------------------------------------------------ helpers

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 5000 : 2500);
}

function timeAgo(ts) {
  if (!ts) return '-';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}

const groupName = (id) => state.groups.find((g) => g.id === id)?.name || '未分组';

function seg(name, options, value) {
  return `<div class="seg">${options
    .map(([v, label]) => `<label><input type="radio" name="${name}" value="${esc(v)}" ${String(v) === String(value) ? 'checked' : ''}><span>${esc(label)}</span></label>`)
    .join('')}</div>`;
}

function selectHtml(name, options, value, cls = 'input') {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (value !== undefined && value !== null && !opts.some(([v]) => String(v) === String(value))) opts.unshift([value, value]);
  return `<select class="${cls}" name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

const field = (label, control, hint = '', attrs = '') =>
  `<div class="field" ${attrs}><label>${label}</label><div>${control}${hint ? `<div class="hint">${hint}</div>` : ''}</div></div>`;

function formValue(form, name) {
  const els = form.elements[name];
  if (!els) return undefined;
  if (els instanceof RadioNodeList) return els.value;
  if (els.type === 'checkbox') return els.checked;
  return els.value;
}

function setValue(form, name, value) {
  const el = form.elements[name];
  if (!el) return;
  if (el instanceof RadioNodeList) {
    for (const r of el) r.checked = String(r.value) === String(value);
  } else if (el.type === 'checkbox') el.checked = !!value;
  else if (el.tagName === 'SELECT') {
    if (![...el.options].some((o) => o.value === String(value))) el.add(new Option(String(value), String(value)), 0);
    el.value = String(value);
  } else el.value = value ?? '';
}

/** Shows/hides elements with data-show="name=v1|v2" according to the form's values. */
function applyVisibility(form) {
  for (const el of $$('[data-show]', form)) {
    const [name, vals] = el.dataset.show.split('=');
    el.style.display = vals.split('|').includes(String(formValue(form, name))) ? '' : 'none';
  }
}

function openLayer(html, { onClose } = {}) {
  const layer = $('#layer');
  layer.innerHTML = `<div class="mask"></div>${html}`;
  const close = () => {
    layer.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  $('.mask', layer).onclick = close;
  for (const b of $$('[data-close]', layer)) b.onclick = close;
  return { root: layer, close };
}

function modal(title, body, { foot = '', wide = false } = {}) {
  return openLayer(
    `<div class="modal ${wide ? 'wide' : ''}"><div class="modal-head"><h2>${title}</h2><button class="x" data-close>×</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`,
  );
}

function confirmBox(title, text, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, `<div>${text}</div>`, { foot: `<button class="btn" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${okLabel}</button>` });
    $('#cf-ok', m.root).onclick = () => {
      done = true;
      m.close();
      resolve(true);
    };
    const obs = new MutationObserver(() => {
      if (!$('.modal', document)) {
        obs.disconnect();
        if (!done) resolve(false);
      }
    });
    obs.observe($('#layer'), { childList: true });
  });
}

let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
});
function showMenu(anchor, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.innerHTML = items.map((it) => (it === '-' ? '<hr>' : `<button class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`)).join('');
  const buttons = $$('button', menuEl);
  items.filter((it) => it !== '-').forEach((it, i) => {
    buttons[i].onclick = () => {
      closeMenu();
      it.run();
    };
  });
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const h = menuEl.offsetHeight;
  menuEl.style.left = `${Math.min(r.right - menuEl.offsetWidth, window.innerWidth - menuEl.offsetWidth - 8)}px`;
  menuEl.style.top = `${r.bottom + 4 + h > window.innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok');
  } catch {
    toast('复制失败，请手动选择复制', 'err');
  }
}

// ------------------------------------------------------------------ data

async function loadAll() {
  const d = await api('GET', '/internal/bootstrap');
  state.profiles = d.profiles;
  state.groups = d.groups;
  state.settings = d.settings;
  state.system = d.system;
  state.presets = d.presets;
  state.running = new Map(d.running.map((r) => [r.id, r]));
  state.status = new Map(d.profiles.map((p) => [p.id, p.status]));
  renderSideFoot();
}

async function reloadProfiles() {
  state.profiles = await api('GET', '/internal/profiles');
  for (const p of state.profiles) if (!state.status.has(p.id) || state.status.get(p.id) !== 'starting') state.status.set(p.id, p.status);
  const ids = new Set(state.profiles.map((p) => p.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  if (state.page === 'profiles') renderProfileRows();
  if (state.page === 'groups') renderGroups();
}

async function reloadGroups() {
  state.groups = await api('GET', '/internal/groups');
  render();
}

function connectEvents() {
  const es = new EventSource('/internal/events');
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    state.status.set(s.id, s.status);
    if (s.info) state.running.set(s.id, s.info);
    else state.running.delete(s.id);
    if (state.page === 'profiles') renderProfileRows();
    renderSideFoot();
  });
  es.addEventListener('profiles', () => reloadProfiles().catch(() => {}));
  es.addEventListener('groups', () => reloadGroups().catch(() => {}));
}

function renderSideFoot() {
  const b = state.system.browser;
  const running = [...state.status.values()].filter((s) => s === 'running').length;
  $('#side-foot').innerHTML = `
    <div><span class="dot ${b ? '' : 'off'}"></span>${b ? `${b.kind === 'edge' ? 'Edge' : 'Chrome'} ${esc(b.version || '')}` : '未找到浏览器'}</div>
    <div>运行中环境：${running}</div>
    <div title="${esc(state.system.apiBase)}">API：${esc((state.system.apiBase || '').replace('http://', ''))}</div>`;
}

// ------------------------------------------------------------------ routing

const PAGES = { profiles: renderProfilesPage, groups: renderGroups, api: renderApiPage, settings: renderSettingsPage };

function route() {
  const page = location.hash.replace(/^#\/?/, '') || 'profiles';
  state.page = PAGES[page] ? page : 'profiles';
  for (const a of $$('#nav a')) a.classList.toggle('active', a.dataset.page === state.page);
  render();
}

function render() {
  PAGES[state.page]();
}

// ------------------------------------------------------------------ profiles page

function renderProfilesPage() {
  $('#main').innerHTML = `
    <div class="page-head"><h1>环境管理</h1><span class="sub">每个环境都是一个独立的浏览器：独立的 Cookie、缓存、指纹与代理</span></div>
    <div class="page-body">
      <div class="toolbar">
        <button class="btn primary" id="btn-new">＋ 新建环境</button>
        <button class="btn" id="btn-batch">批量创建</button>
        <span style="width:8px"></span>
        <button class="btn" data-bulk="start">打开</button>
        <button class="btn" data-bulk="stop">关闭</button>
        <button class="btn" data-bulk="move">移动分组</button>
        <button class="btn danger" data-bulk="delete">删除</button>
        <div class="spacer"></div>
        <select class="input" id="flt-group"><option value="">全部分组</option>${state.groups.map((g) => `<option value="${esc(g.id)}" ${state.filter.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        <input class="input search" id="flt-q" placeholder="搜索名称 / 备注 / IP / 编号" value="${esc(state.filter.q)}">
      </div>
      <div class="card">
        <div class="table-wrap"><table class="list">
          <thead><tr><th class="chk"><input type="checkbox" id="chk-all"></th><th>编号</th><th>名称</th><th>分组</th><th>代理 / 出口 IP</th><th>指纹</th><th>最近打开</th><th style="width:170px">操作</th></tr></thead>
          <tbody id="rows"></tbody>
        </table></div>
        <div class="footer-bar"><span id="count"></span><span id="sel-count"></span></div>
      </div>
    </div>`;
  $('#btn-new').onclick = () => openEditor(null);
  $('#btn-batch').onclick = openBatchCreate;
  $('#flt-group').onchange = (e) => {
    state.filter.groupId = e.target.value;
    renderProfileRows();
  };
  $('#flt-q').oninput = (e) => {
    state.filter.q = e.target.value;
    renderProfileRows();
  };
  $('#chk-all').onchange = (e) => {
    for (const p of visibleProfiles()) e.target.checked ? state.selected.add(p.id) : state.selected.delete(p.id);
    renderProfileRows();
  };
  for (const b of $$('[data-bulk]')) b.onclick = (e) => bulkAction(b.dataset.bulk, e.currentTarget);
  $('#rows').onclick = onRowClick;
  $('#rows').onchange = (e) => {
    if (e.target.matches('input[data-sel]')) {
      e.target.checked ? state.selected.add(e.target.dataset.sel) : state.selected.delete(e.target.dataset.sel);
      renderProfileRows();
    }
  };
  renderProfileRows();
}

function visibleProfiles() {
  const q = state.filter.q.trim().toLowerCase();
  return state.profiles.filter((p) => {
    if (state.filter.groupId && p.groupId !== state.filter.groupId) return false;
    if (!q) return true;
    return [p.name, p.remark, p.id, String(p.serial), p.proxy?.host, p.lastIpInfo?.ip].some((v) => v && String(v).toLowerCase().includes(q));
  });
}

function proxyCell(p) {
  const px = p.proxy;
  const proxy = px && px.type !== 'none' ? `<span class="tag">${esc(px.type.toUpperCase())}</span> <span class="mono">${esc(px.host)}:${esc(px.port)}</span>` : '<span class="tag">直连</span>';
  const info = state.running.get(p.id)?.ipInfo || p.lastIpInfo;
  const ip = info ? `<div class="small">${info.countryCode ? `<span class="cc">${esc(info.countryCode)}</span>` : ''}${esc(info.ip)} ${esc([info.city].filter(Boolean).join(''))}</div>` : '';
  return proxy + ip;
}

function fpCell(p) {
  const f = p.fingerprint || {};
  const parts = [];
  parts.push(f.screen?.mode === 'custom' ? `${f.screen.width}×${f.screen.height}` : '真实分辨率');
  if (f.hardwareConcurrency) parts.push(`${f.hardwareConcurrency}核`);
  if (f.deviceMemory) parts.push(`${f.deviceMemory}G`);
  return `<span class="tag os-${esc(f.os)}">${esc(OS_LABEL[f.os] || f.os)}</span> <span class="small">${esc(parts.join(' · '))}</span>`;
}

function actionCell(p) {
  const st = state.status.get(p.id) || 'stopped';
  const main =
    st === 'running'
      ? `<button class="btn sm close" data-act="stop">关闭</button>`
      : st === 'starting'
        ? `<button class="btn sm" disabled><span class="dot busy"></span>启动中</button>`
        : `<button class="btn sm open" data-act="start">打开</button>`;
  return `<div class="actions">${main}<button class="btn sm ghost" data-act="edit">编辑</button><button class="btn sm ghost" data-act="more">⋯</button></div>`;
}

function renderProfileRows() {
  const tbody = $('#rows');
  if (!tbody) return;
  const list = visibleProfiles();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="big">${state.profiles.length ? '没有匹配的环境' : '还没有环境'}</div>${state.profiles.length ? '' : '点击「新建环境」创建第一个浏览器环境'}</div></td></tr>`;
  } else {
    tbody.innerHTML = list
      .map((p) => {
        const st = state.status.get(p.id);
        return `<tr data-id="${esc(p.id)}" class="${state.selected.has(p.id) ? 'sel' : ''}">
          <td class="chk"><input type="checkbox" data-sel="${esc(p.id)}" ${state.selected.has(p.id) ? 'checked' : ''}></td>
          <td><span class="dot ${st === 'running' ? '' : st === 'starting' ? 'busy' : 'off'}"></span>${esc(p.serial)}</td>
          <td class="name-cell"><b>${esc(p.name)}</b>${p.remark ? `<div class="small ellipsis" title="${esc(p.remark)}">${esc(p.remark)}</div>` : ''}</td>
          <td><span class="tag blue">${esc(groupName(p.groupId))}</span></td>
          <td>${proxyCell(p)}</td>
          <td>${fpCell(p)}</td>
          <td class="small" title="${p.lastOpenedAt ? esc(new Date(p.lastOpenedAt).toLocaleString()) : ''}">${timeAgo(p.lastOpenedAt)}</td>
          <td>${actionCell(p)}</td></tr>`;
      })
      .join('');
  }
  const all = $('#chk-all');
  if (all) all.checked = list.length > 0 && list.every((p) => state.selected.has(p.id));
  $('#count').textContent = `共 ${list.length} 个环境`;
  $('#sel-count').textContent = state.selected.size ? `已选 ${state.selected.size} 个` : '';
  for (const b of $$('[data-bulk]')) b.disabled = state.selected.size === 0;
}

async function startProfile(id) {
  state.status.set(id, 'starting');
  renderProfileRows();
  try {
    await api('POST', `/internal/profiles/${id}/start`, {});
  } catch (e) {
    state.status.set(id, 'stopped');
    renderProfileRows();
    toast(`打开失败：${e.message}`, 'err');
  }
}

async function stopProfile(id) {
  try {
    await api('POST', `/internal/profiles/${id}/stop`, {});
  } catch (e) {
    toast(e.message, 'err');
  }
}

function onRowClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const p = state.profiles.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'start') startProfile(id);
  else if (act === 'stop') stopProfile(id);
  else if (act === 'edit') openEditor(p);
  else if (act === 'more') {
    e.stopPropagation();
    showMenu(btn, [
      { label: '复制环境（新指纹）', run: () => cloneProfile(p) },
      { label: '导入 Cookie', run: () => openCookieImport(p) },
      { label: '导出 Cookie', run: () => exportCookies(p) },
      { label: '清空 Cookie', run: () => clearCookies(p) },
      { label: '复制环境 ID', run: () => copy(p.id) },
      '-',
      { label: '删除环境', danger: true, run: () => deleteProfiles([p.id]) },
    ]);
  }
}

async function cloneProfile(p) {
  try {
    await api('POST', `/internal/profiles/${p.id}/clone`, {});
    toast('已复制', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteProfiles(ids) {
  const ok = await confirmBox('删除环境', `确定删除 ${ids.length} 个环境？<br><span class="small">环境的浏览器数据（Cookie、缓存、登录状态）会被一起删除，无法恢复。</span>`, '删除', true);
  if (!ok) return;
  try {
    await api('POST', '/internal/profiles/delete', { ids });
    for (const id of ids) state.selected.delete(id);
    toast('已删除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function bulkAction(kind, anchor) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (kind === 'delete') return deleteProfiles(ids);
  if (kind === 'move') {
    return showMenu(
      anchor,
      state.groups.map((g) => ({
        label: g.name,
        run: async () => {
          await api('POST', '/internal/profiles/move', { ids, groupId: g.id }).catch((e) => toast(e.message, 'err'));
        },
      })),
    );
  }
  if (kind === 'start') {
    const todo = ids.filter((id) => state.status.get(id) !== 'running');
    for (const id of todo) state.status.set(id, 'starting');
    renderProfileRows();
    const res = await api('POST', '/internal/profiles/start', { ids: todo }).catch((e) => (toast(e.message, 'err'), []));
    const failed = res.filter((r) => !r.ok);
    for (const r of failed) state.status.set(r.id, 'stopped');
    renderProfileRows();
    if (failed.length) toast(`${failed.length} 个环境打开失败：${failed[0].error}`, 'err');
  }
  if (kind === 'stop') await api('POST', '/internal/profiles/stop', { ids }).catch((e) => toast(e.message, 'err'));
}

// ------------------------------------------------------------------ cookies

function openCookieImport(p) {
  const m = modal(
    `导入 Cookie · #${esc(p.serial)} ${esc(p.name)}`,
    `<textarea class="input" id="ck-text" rows="12" placeholder='[{"domain":".example.com","name":"sid","value":"...","path":"/","expirationDate":1767225600}]'></textarea>
     <div class="hint small" style="margin-top:6px">支持 JSON（EditThisCookie / Cookie-Editor / AdsPower 导出格式）或 Netscape cookies.txt。环境未打开时会在下次打开时导入。</div>`,
    { foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="ck-ok">导入</button>', wide: true },
  );
  $('#ck-ok', m.root).onclick = async () => {
    try {
      const r = await api('POST', `/internal/profiles/${p.id}/cookies`, { cookies: $('#ck-text', m.root).value });
      toast(r.applied ? `已导入 ${r.applied} 条 Cookie` : `已保存 ${r.queued} 条 Cookie，将在下次打开时导入`, 'ok');
      m.close();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

async function exportCookies(p) {
  toast('正在读取 Cookie…');
  try {
    const list = await api('GET', `/internal/profiles/${p.id}/cookies`);
    const text = JSON.stringify(list, null, 2);
    const m = modal(`导出 Cookie · #${esc(p.serial)} ${esc(p.name)}（${list.length} 条）`, `<textarea class="input" rows="16" readonly>${esc(text)}</textarea>`, {
      foot: '<button class="btn" id="ck-copy">复制</button><button class="btn primary" id="ck-dl">下载 JSON</button>',
      wide: true,
    });
    $('#ck-copy', m.root).onclick = () => copy(text);
    $('#ck-dl', m.root).onclick = () => download(`cookies-${p.serial}-${p.id}.json`, text);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function clearCookies(p) {
  if (!(await confirmBox('清空 Cookie', `确定清空 #${esc(p.serial)} ${esc(p.name)} 的全部 Cookie？登录状态将丢失。`, '清空', true))) return;
  try {
    await api('DELETE', `/internal/profiles/${p.id}/cookies`);
    toast('已清空', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ------------------------------------------------------------------ batch create

function openBatchCreate() {
  const m = modal(
    '批量创建环境',
    `<form id="bf">
      ${field('数量', '<input class="input" type="number" name="count" value="5" min="1" max="500">', '填写了代理列表时，留空则按代理行数创建')}
      ${field('名称前缀', '<input class="input" name="namePrefix" placeholder="如：店铺-">', '留空则使用「环境 编号」')}
      ${field('分组', selectHtml('groupId', state.groups.map((g) => [g.id, g.name]), '0'))}
      ${field('操作系统', seg('os', Object.entries(OS_LABEL), state.system.hostOS || 'windows'), '每个环境都会生成独立的随机指纹')}
      ${field('默认代理类型', seg('proxyType', [['http', 'HTTP'], ['https', 'HTTPS'], ['socks5', 'SOCKS5']], 'http'), '代理行未写协议时使用')}
      ${field('代理列表', '<textarea class="input" name="proxies" rows="6" placeholder="每行一个，按顺序分配：\nsocks5://user:pass@1.2.3.4:1080\n1.2.3.4:8080:user:pass\nhost:port"></textarea>')}
    </form>`,
    { foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="bf-ok">创建</button>' },
  );
  $('#bf-ok', m.root).onclick = async () => {
    const f = $('#bf', m.root);
    const body = { count: Number(formValue(f, 'count')) || 0, namePrefix: formValue(f, 'namePrefix'), groupId: formValue(f, 'groupId'), os: formValue(f, 'os'), proxyType: formValue(f, 'proxyType'), proxies: formValue(f, 'proxies') };
    if (body.proxies.trim() && !f.elements.count.dataset.touched) body.count = 0;
    try {
      const list = await api('POST', '/internal/profiles/batch', body);
      toast(`已创建 ${list.length} 个环境`, 'ok');
      m.close();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $('#bf', m.root).elements.count.oninput = (e) => (e.target.dataset.touched = '1');
}

// ------------------------------------------------------------------ editor

const TABS = [
  ['basic', '基础设置'],
  ['proxy', '代理设置'],
  ['fp', '指纹设置'],
];

// Common monitor resolutions in physical pixels. Sites see screen size in CSS pixels together with
// devicePixelRatio (the real display scaling of this machine), so a plausible CSS size is physical ÷ DPR.
const PHYSICAL_SCREENS = [[1920, 1080], [2560, 1440], [3840, 2160], [1366, 768], [1600, 900], [1920, 1200], [2560, 1600], [1440, 900], [3440, 1440]];
const DPR = window.devicePixelRatio || 1;

function fittingScreens() {
  const seen = new Set();
  return PHYSICAL_SCREENS.map(([w, h]) => [Math.round(w / DPR), Math.round(h / DPR)]).filter(([w, h]) => {
    const k = `${w}x${h}`;
    if (w < 1200 || h < 700 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function screenOptions(os) {
  // Macs are DPR 2 (or 1), so the scaling of a Windows/Linux host never fits them anyway
  const fit = os === 'macos' ? [] : fittingScreens();
  const fitKeys = new Set(fit.map(([w, h]) => `${w}x${h}`));
  return [
    ...fit.map(([w, h]) => [`${w}x${h}`, `${w} × ${h}（适配本机 ${Math.round(DPR * 100)}% 缩放）`]),
    ...(state.presets.screens[os] || []).filter(([w, h]) => !fitKeys.has(`${w}x${h}`)).map(([w, h]) => [`${w}x${h}`, `${w} × ${h}`]),
  ];
}

function gpuOptions(os) {
  return [['', '选择预设显卡…'], ...(state.presets.gpus[os] || []).map(([v, r]) => [`${v}|${r}`, r.replace(/^ANGLE \(/, '').replace(/\)$/, '')])];
}

function editorHtml(p) {
  const f = p.fingerprint;
  const px = p.proxy || { type: 'none' };
  const cpu = [[0, '真实'], ...[2, 4, 6, 8, 10, 12, 16, 20, 24, 32].map((n) => [n, `${n} 核`])];
  const mem = [[0, '真实'], ...[1, 2, 4, 8].map((n) => [n, `${n} GB`])];
  const noise = [['noise', '噪声'], ['real', '真实']];
  return `
  <div class="tabs">${TABS.map(([k, l], i) => `<button type="button" data-tab="${k}" class="${i === 0 ? 'active' : ''}">${l}</button>`).join('')}</div>
  <form id="ed" autocomplete="off">
    <section data-pane="basic">
      ${field('环境名称', `<input class="input" name="name" value="${esc(p.name || '')}" placeholder="留空自动命名">`)}
      ${field('分组', selectHtml('groupId', state.groups.map((g) => [g.id, g.name]), p.groupId || '0'))}
      ${field('备注', `<textarea class="input" name="remark" rows="2" style="font-family:inherit;min-height:50px">${esc(p.remark || '')}</textarea>`)}
      ${field('启动页面', `<textarea class="input" name="startUrls" rows="3" placeholder="每行一个网址，打开环境时自动访问">${esc((p.startUrls || []).join('\n'))}</textarea>`)}
      ${field(
        'Cookie',
        `<div class="inline" style="margin-bottom:6px;flex-wrap:wrap;gap:8px">
           ${p.id ? '<button type="button" class="btn" id="ck-load">读取环境当前 Cookie</button>' : ''}
           <button type="button" class="btn" id="ck-copy">复制</button>
           <button type="button" class="btn" id="ck-clear">清空</button>
           <span class="muted" id="ck-status">${p.pendingCookieCount ? `待导入 ${p.pendingCookieCount} 条` : ''}</span>
         </div>
         <textarea class="input" name="cookies" rows="8" placeholder="点「读取环境当前 Cookie」把该环境已经产生的 Cookie 拉出来（运行中也能读）；也可以在这里粘贴 JSON / Netscape 覆盖导入"></textarea>`,
        '读取 / 复制用于导出；粘贴后点保存，将在<strong>下次打开</strong>环境时导入。',
      )}
    </section>
    <section data-pane="proxy" style="display:none">
      ${field('代理类型', seg('proxy.type', [['none', '不使用代理'], ['http', 'HTTP'], ['https', 'HTTPS'], ['socks5', 'SOCKS5']], px.type))}
      <div data-show="proxy.type=http|https|socks5">
        ${field('快速填写', '<input class="input" id="px-paste" placeholder="粘贴 socks5://user:pass@host:port 或 host:port:user:pass 自动识别">')}
        ${field('主机 / 端口', `<div class="row2" style="grid-template-columns:1fr 120px"><input class="input" name="proxy.host" value="${esc(px.host || '')}" placeholder="IP 或域名"><input class="input" name="proxy.port" type="number" value="${esc(px.port || '')}" placeholder="端口"></div>`)}
        ${field('账号 / 密码', `<div class="row2"><input class="input" name="proxy.username" value="${esc(px.username || '')}" placeholder="可选"><input class="input" name="proxy.password" type="password" value="${esc(px.password || '')}" placeholder="可选"></div>`)}
      </div>
      ${field('', '<button type="button" class="btn" id="px-check">检查代理</button><div id="px-result"></div>', 'HTTP / SOCKS5 带账号密码的代理由本地转发，浏览器不会弹出认证框；DNS 由代理端解析。')}
    </section>
    <section data-pane="fp" style="display:none">
      <div class="inline" style="justify-content:space-between;margin:4px 0 12px">
        <div class="small">时区、语言、地理位置默认「基于 IP」：打开环境时按代理出口 IP 自动匹配。</div>
        <button type="button" class="btn" id="fp-random">🎲 随机生成指纹</button>
      </div>
      <input type="hidden" name="fp.seed" value="${esc(f.seed)}">
      <input type="hidden" name="fp.platformVersion" value="${esc(f.platformVersion || '')}">
      <div class="section-title">系统与 UA</div>
      ${field('操作系统', seg('fp.os', Object.entries(OS_LABEL), f.os), '建议与本机系统一致；跨系统伪装会在字体等细节上露出差异')}
      ${field('User-Agent', `<input class="input mono" name="fp.userAgent" value="${esc(f.userAgent || '')}" placeholder="留空 = 自动匹配浏览器内核版本（推荐）">`)}
      <div class="section-title">网络与位置</div>
      ${field('WebRTC', seg('fp.webrtc', [['proxy', '转发（防泄露）'], ['disabled', '禁用'], ['real', '真实']], f.webrtc))}
      ${field('时区', `${seg('fp.timezone.mode', [['ip', '基于 IP'], ['custom', '自定义'], ['real', '真实']], f.timezone.mode)}<div data-show="fp.timezone.mode=custom" style="margin-top:8px">${selectHtml('fp.timezone.value', state.presets.timezones, f.timezone.value)}</div>`)}
      ${field('语言', `${seg('fp.language.mode', [['ip', '基于 IP'], ['custom', '自定义']], f.language.mode)}<div data-show="fp.language.mode=custom" style="margin-top:8px"><input class="input" name="fp.language.value" list="lang-list" value="${esc(f.language.value)}"><datalist id="lang-list">${state.presets.languages.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>`)}
      ${field(
        '地理位置',
        `${seg('fp.geolocation.permission', [['ask', '询问'], ['allow', '允许'], ['block', '禁止']], f.geolocation.permission)}
         <div data-show="fp.geolocation.permission=ask|allow" style="margin-top:8px">${seg('fp.geolocation.mode', [['ip', '基于 IP'], ['custom', '自定义坐标']], f.geolocation.mode)}
           <div data-show="fp.geolocation.mode=custom" class="row3" style="margin-top:8px"><input class="input" name="fp.geolocation.latitude" type="number" step="any" value="${esc(f.geolocation.latitude)}" placeholder="纬度"><input class="input" name="fp.geolocation.longitude" type="number" step="any" value="${esc(f.geolocation.longitude)}" placeholder="经度"><input class="input" name="fp.geolocation.accuracy" type="number" value="${esc(f.geolocation.accuracy)}" placeholder="精度(米)"></div>
         </div>`,
      )}
      <div class="section-title">硬件</div>
      ${field(
        '分辨率',
        `${seg('fp.screen.mode', [['real', '真实'], ['custom', '自定义']], f.screen.mode)}<div data-show="fp.screen.mode=custom" style="margin-top:8px" id="screen-wrap">${selectHtml('fp.screen.size', screenOptions(f.os), `${f.screen.width}x${f.screen.height}`)}</div>`,
        `网站能读到本机的显示缩放（当前 ${Math.round(DPR * 100)}%），自定义分辨率请优先选「适配本机缩放」的选项；任务栏高度和窗口位置会自动与之匹配。`,
      )}
      ${field('CPU 核心数', selectHtml('fp.hardwareConcurrency', cpu, f.hardwareConcurrency))}
      ${field('设备内存', selectHtml('fp.deviceMemory', mem, f.deviceMemory))}
      <div class="section-title">图形与音频</div>
      ${field('Canvas', seg('fp.canvas', noise, f.canvas))}
      ${field('WebGL 图像', seg('fp.webglImage', noise, f.webglImage))}
      ${field(
        'WebGL 元数据',
        `${seg('fp.webgl.mode', [['custom', '自定义'], ['real', '真实']], f.webgl.mode)}
         <div data-show="fp.webgl.mode=custom" class="stack" style="margin-top:8px">
           <span id="gpu-wrap">${selectHtml('gpu-preset', gpuOptions(f.os), '')}</span>
           <input class="input mono" name="fp.webgl.vendor" value="${esc(f.webgl.vendor)}" placeholder="Unmasked Vendor">
           <input class="input mono" name="fp.webgl.renderer" value="${esc(f.webgl.renderer)}" placeholder="Unmasked Renderer">
         </div>`,
      )}
      ${field('AudioContext', seg('fp.audio', noise, f.audio))}
      ${field('语音列表', seg('fp.voices', [['match', '匹配系统与语言'], ['real', '真实']], f.voices || 'match'), '本机的系统语音会暴露真实系统语言（例如中文 Windows 的 Huihui / Yaoyao），匹配后显示与环境系统、语言一致的语音')}
      ${field('ClientRects', seg('fp.clientRects', noise, f.clientRects))}
    </section>
  </form>`;
}

function fillFingerprint(form, fp) {
  setValue(form, 'fp.os', fp.os);
  refreshOsPresets(form, fp.os);
  for (const k of ['seed', 'platformVersion', 'userAgent', 'webrtc', 'hardwareConcurrency', 'deviceMemory', 'canvas', 'webglImage', 'audio', 'clientRects', 'voices']) setValue(form, `fp.${k}`, fp[k]);
  setValue(form, 'fp.timezone.mode', fp.timezone.mode);
  setValue(form, 'fp.timezone.value', fp.timezone.value);
  setValue(form, 'fp.language.mode', fp.language.mode);
  setValue(form, 'fp.language.value', fp.language.value);
  for (const k of ['permission', 'mode', 'latitude', 'longitude', 'accuracy']) setValue(form, `fp.geolocation.${k}`, fp.geolocation[k]);
  setValue(form, 'fp.screen.mode', fp.screen.mode);
  setValue(form, 'fp.screen.size', `${fp.screen.width}x${fp.screen.height}`);
  setValue(form, 'fp.webgl.mode', fp.webgl.mode);
  setValue(form, 'fp.webgl.vendor', fp.webgl.vendor);
  setValue(form, 'fp.webgl.renderer', fp.webgl.renderer);
  applyVisibility(form);
}

function refreshOsPresets(form, os) {
  const size = formValue(form, 'fp.screen.size');
  $('#screen-wrap', form).innerHTML = selectHtml('fp.screen.size', screenOptions(os), screenOptions(os).some(([v]) => v === size) ? size : screenOptions(os)[0][0]);
  $('#gpu-wrap', form).innerHTML = selectHtml('gpu-preset', gpuOptions(os), '');
  bindGpuPreset(form);
}

function bindGpuPreset(form) {
  form.elements['gpu-preset'].onchange = (e) => {
    const [v, r] = e.target.value.split('|');
    if (!r) return;
    setValue(form, 'fp.webgl.vendor', v);
    setValue(form, 'fp.webgl.renderer', r);
  };
}

function collectEditor(form) {
  const v = (n) => formValue(form, n);
  const [w, h] = String(v('fp.screen.size') || '1920x1080').split('x').map(Number);
  const out = {
    name: v('name'),
    groupId: v('groupId'),
    remark: v('remark'),
    startUrls: v('startUrls'),
    proxy: { type: v('proxy.type'), host: v('proxy.host').trim(), port: Number(v('proxy.port')) || 0, username: v('proxy.username'), password: v('proxy.password') },
    fingerprint: {
      os: v('fp.os'),
      seed: Number(v('fp.seed')),
      platformVersion: v('fp.platformVersion') || undefined,
      userAgent: v('fp.userAgent').trim(),
      webrtc: v('fp.webrtc'),
      timezone: { mode: v('fp.timezone.mode'), value: v('fp.timezone.value') },
      language: { mode: v('fp.language.mode'), value: v('fp.language.value') },
      geolocation: {
        permission: v('fp.geolocation.permission'),
        mode: v('fp.geolocation.mode'),
        latitude: Number(v('fp.geolocation.latitude')),
        longitude: Number(v('fp.geolocation.longitude')),
        accuracy: Number(v('fp.geolocation.accuracy')) || 100,
      },
      screen: { mode: v('fp.screen.mode'), width: w, height: h },
      hardwareConcurrency: Number(v('fp.hardwareConcurrency')),
      deviceMemory: Number(v('fp.deviceMemory')),
      canvas: v('fp.canvas'),
      webglImage: v('fp.webglImage'),
      webgl: { mode: v('fp.webgl.mode'), vendor: v('fp.webgl.vendor'), renderer: v('fp.webgl.renderer') },
      audio: v('fp.audio'),
      clientRects: v('fp.clientRects'),
      voices: v('fp.voices'),
    },
  };
  if (v('cookies').trim()) out.cookies = v('cookies');
  return out;
}

async function openEditor(profile) {
  let p = profile;
  if (!p) {
    const fp = await api('GET', `/internal/fingerprint/random?os=${state.system.hostOS || 'windows'}`).catch((e) => (toast(e.message, 'err'), null));
    if (!fp) return;
    p = { name: '', groupId: state.filter.groupId || '0', proxy: { type: 'none' }, fingerprint: fp, startUrls: [] };
  }
  const running = profile && state.status.get(profile.id) === 'running';
  const layer = openLayer(`
    <div class="drawer">
      <div class="drawer-head"><h2>${profile ? `编辑环境 #${esc(profile.serial)}` : '新建环境'}</h2><button class="x" data-close>×</button></div>
      <div class="drawer-body">${running ? '<div class="summary">该环境正在运行，修改的指纹与代理将在下次打开时生效。</div>' : ''}${editorHtml(p)}</div>
      <div class="drawer-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="ed-save">${profile ? '保存' : '创建'}</button></div>
    </div>`);
  const root = layer.root;
  const form = $('#ed', root);
  applyVisibility(form);
  bindGpuPreset(form);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'fp.os') refreshOsPresets(form, e.target.value);
    applyVisibility(form);
  });
  for (const b of $$('[data-tab]', root)) {
    b.onclick = () => {
      for (const x of $$('[data-tab]', root)) x.classList.toggle('active', x === b);
      for (const s of $$('[data-pane]', root)) s.style.display = s.dataset.pane === b.dataset.tab ? '' : 'none';
    };
  }
  if ($('#ck-load', root)) {
    $('#ck-load', root).onclick = async (e) => {
      const btn = e.currentTarget;
      const st = $('#ck-status', root);
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '读取中…';
      try {
        const list = await api('GET', `/internal/profiles/${profile.id}/cookies`);
        form.elements.cookies.value = list.length ? JSON.stringify(list, null, 1) : '';
        const domains = new Set(list.map((c) => c.domain).filter(Boolean));
        st.textContent = list.length ? `${list.length} 条 · ${domains.size} 个域名` : '该环境还没有 Cookie';
        toast(`已读取 ${list.length} 条 Cookie`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
  }
  $('#ck-copy', root).onclick = async () => {
    const v = form.elements.cookies.value.trim();
    if (!v) return toast('没有内容可复制', 'err');
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制到剪贴板', 'ok');
    } catch {
      form.elements.cookies.select();
      toast('已选中，按 Ctrl+C 复制', '');
    }
  };
  $('#ck-clear', root).onclick = () => {
    form.elements.cookies.value = '';
    $('#ck-status', root).textContent = '';
  };
  $('#px-paste', root).onchange = async (e) => {
    const text = e.target.value.trim();
    if (!text) return;
    try {
      const type = formValue(form, 'proxy.type');
      const px = await api('POST', '/internal/proxy/parse', { text, type: type === 'none' ? 'http' : type });
      for (const k of ['type', 'host', 'port', 'username', 'password']) setValue(form, `proxy.${k}`, px[k]);
      applyVisibility(form);
      e.target.value = '';
      toast('已识别代理', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#px-check', root).onclick = async (e) => {
    const out = $('#px-result', root);
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '检查中…';
    out.innerHTML = '';
    try {
      const r = await api('POST', '/internal/proxy/check', { proxy: collectEditor(form).proxy });
      out.innerHTML = `<div class="check-result ok">✓ 连接成功 · <b>${esc(r.ip)}</b> · ${esc([r.country, r.region, r.city].filter(Boolean).join(' / '))} · ${esc(r.timezone || '')} · ${r.latency} ms</div>`;
    } catch (err) {
      out.innerHTML = `<div class="check-result err">✗ ${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '检查代理';
    }
  };
  $('#fp-random', root).onclick = async () => {
    try {
      const fp = await api('GET', `/internal/fingerprint/random?os=${formValue(form, 'fp.os')}&screen=${formValue(form, 'fp.screen.mode')}`);
      // keep the user's choices for the IP-based settings
      for (const k of ['timezone', 'language', 'geolocation', 'webrtc', 'voices']) delete fp[k];
      const fit = fp.os === 'macos' ? [] : fittingScreens();
      if (fp.screen.mode === 'custom' && fit.length) [fp.screen.width, fp.screen.height] = fit[Math.floor(Math.random() * fit.length)];
      fillFingerprint(form, { ...collectEditor(form).fingerprint, ...fp, userAgent: '' });
      toast('已生成新指纹', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#ed-save', root).onclick = async () => {
    const body = collectEditor(form);
    try {
      if (profile) await api('PUT', `/internal/profiles/${profile.id}`, body);
      else await api('POST', '/internal/profiles', body);
      toast(profile ? '已保存' : '已创建', 'ok');
      layer.close();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

// ------------------------------------------------------------------ groups page

function renderGroups() {
  const counts = new Map();
  for (const p of state.profiles) counts.set(p.groupId, (counts.get(p.groupId) || 0) + 1);
  $('#main').innerHTML = `
    <div class="page-head"><h1>分组管理</h1><span class="sub">按业务、店铺或账号类型组织环境</span></div>
    <div class="page-body">
      <div class="toolbar"><button class="btn primary" id="g-new">＋ 新建分组</button></div>
      <div class="card"><table class="list">
        <thead><tr><th>分组名称</th><th>环境数量</th><th>备注</th><th style="width:160px">操作</th></tr></thead>
        <tbody>${state.groups
          .map(
            (g) => `<tr data-id="${esc(g.id)}"><td><b>${esc(g.name)}</b>${g.id === '0' ? ' <span class="tag">默认</span>' : ''}</td><td>${counts.get(g.id) || 0}</td><td class="small">${esc(g.remark || '')}</td>
              <td><div class="actions"><button class="btn sm ghost" data-g="view">查看环境</button>${g.id === '0' ? '' : '<button class="btn sm ghost" data-g="edit">编辑</button><button class="btn sm ghost danger" data-g="del">删除</button>'}</div></td></tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`;
  $('#g-new').onclick = () => groupDialog(null);
  $('#main tbody').onclick = async (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    const g = state.groups.find((x) => x.id === b.closest('tr').dataset.id);
    if (b.dataset.g === 'view') {
      state.filter.groupId = g.id;
      location.hash = '#/profiles';
    } else if (b.dataset.g === 'edit') groupDialog(g);
    else if (b.dataset.g === 'del') {
      if (!(await confirmBox('删除分组', `删除分组「${esc(g.name)}」？其中的环境会移到「未分组」，不会被删除。`, '删除', true))) return;
      api('DELETE', `/internal/groups/${g.id}`).then(() => toast('已删除', 'ok'), (err) => toast(err.message, 'err'));
    }
  };
}

function groupDialog(g) {
  const m = modal(
    g ? '编辑分组' : '新建分组',
    `<form id="gf">${field('分组名称', `<input class="input" name="name" value="${esc(g?.name || '')}">`)}${field('备注', `<input class="input" name="remark" value="${esc(g?.remark || '')}">`)}</form>`,
    { foot: '<button class="btn" data-close>取消</button><button class="btn primary" id="gf-ok">确定</button>' },
  );
  const f = $('#gf', m.root);
  f.elements.name.focus();
  const submit = async () => {
    const body = { name: formValue(f, 'name'), remark: formValue(f, 'remark') };
    try {
      if (g) await api('PUT', `/internal/groups/${g.id}`, body);
      else await api('POST', '/internal/groups', body);
      m.close();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $('#gf-ok', m.root).onclick = submit;
  f.onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
}

// ------------------------------------------------------------------ API page

function renderApiPage() {
  const base = state.system.apiBase || location.origin;
  const keyHeader = state.settings.apiKey ? `, headers: { Authorization: 'Bearer ${state.settings.apiKey}' }` : '';
  const puppeteer = `const puppeteer = require('puppeteer-core');

const res = await fetch('${base}/api/v1/browser/start?user_id=USER_ID'${keyHeader ? `, {${keyHeader.slice(2)}}` : ''});
const { data } = await res.json();
const browser = await puppeteer.connect({ browserWSEndpoint: data.ws.puppeteer, defaultViewport: null });
const page = await browser.newPage();
await page.goto('https://example.com');
// ...
await fetch('${base}/api/v1/browser/stop?user_id=USER_ID');`;
  const playwright = `from playwright.sync_api import sync_playwright
import requests

data = requests.get('${base}/api/v1/browser/start', params={'user_id': 'USER_ID'}).json()['data']
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(data['ws']['puppeteer'])
    page = browser.contexts[0].new_page()
    page.goto('https://example.com')`;
  const selenium = `from selenium import webdriver
from selenium.webdriver.chrome.service import Service
import requests

data = requests.get('${base}/api/v1/browser/start', params={'user_id': 'USER_ID'}).json()['data']
opts = webdriver.ChromeOptions()
opts.add_experimental_option('debuggerAddress', data['ws']['selenium'])
driver = webdriver.Chrome(service=Service(data['webdriver'] or None), options=opts)`;
  const endpoints = [
    ['GET /status', '服务状态'],
    ['GET /api/v1/browser/start', '打开环境：user_id 或 serial_number；可选 headless=1、ip_tab=0、open_tabs=1、launch_args=["--x"]'],
    ['GET /api/v1/browser/stop', '关闭环境：user_id 或 serial_number'],
    ['GET /api/v1/browser/active', '查询环境是否运行，返回 ws 地址'],
    ['GET /api/v1/browser/local-active', '列出所有运行中的环境'],
    ['GET /api/v1/user/list', '环境列表：group_id、user_id、serial_number、page、page_size'],
    ['POST /api/v1/user/create', '创建环境：name、group_id、user_proxy_config、fingerprint_config、cookie、open_urls'],
    ['POST /api/v1/user/update', '修改环境：user_id + 同 create 字段'],
    ['POST /api/v1/user/delete', '删除环境：user_ids: []'],
    ['POST /api/v1/user/regroup', '移动分组：user_ids、group_id'],
    ['GET /api/v1/group/list', '分组列表'],
    ['POST /api/v1/group/create', '创建分组：group_name、remark'],
    ['POST /api/v1/group/update', '修改分组：group_id、group_name、remark'],
  ];
  $('#main').innerHTML = `
    <div class="page-head"><h1>API · 自动化</h1><span class="sub">接口与 AdsPower Local API 兼容，现有脚本把地址改成下面的即可</span></div>
    <div class="page-body">
      <div class="card pad" style="margin-bottom:16px">
        <div class="kv">
          <div>API 地址</div><div><code>${esc(base)}</code> <button class="btn sm" id="cp-base">复制</button></div>
          <div>API Key</div><div>${state.settings.apiKey ? '<span class="tag green">已启用</span> 请求需带 <code>Authorization: Bearer &lt;key&gt;</code>' : '<span class="tag">未启用</span> 可在「设置」中开启'}</div>
          <div>说明</div><div class="small">仅监听 127.0.0.1；来自网页的跨站请求会被拒绝。接口返回的 <code>ws.puppeteer</code> 可直接用于 Puppeteer / Playwright 的 CDP 连接。</div>
        </div>
      </div>
      <div class="grid2">
        <div class="card pad"><h3>接口列表</h3><table class="api">${endpoints.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table></div>
        <div class="stack">
          <div class="card pad"><h3>Puppeteer (Node.js)</h3><pre class="code">${esc(puppeteer)}</pre></div>
          <div class="card pad"><h3>Playwright (Python)</h3><pre class="code">${esc(playwright)}</pre></div>
          <div class="card pad"><h3>Selenium (Python)</h3><pre class="code">${esc(selenium)}</pre><div class="small" style="margin-top:6px">需要与浏览器版本匹配的 chromedriver，可在「设置」中填写路径。</div></div>
        </div>
      </div>
    </div>`;
  $('#cp-base').onclick = () => copy(base);
}

// ------------------------------------------------------------------ settings page

function renderSettingsPage() {
  const s = state.settings;
  const sys = state.system;
  $('#main').innerHTML = `
    <div class="page-head"><h1>设置</h1></div>
    <div class="page-body">
      <div class="card pad" style="max-width:860px">
        <form id="sf">
          <div class="section-title">浏览器内核</div>
          ${field(
            '浏览器路径',
            `<input class="input mono" name="browserPath" list="br-list" value="${esc(s.browserPath)}" placeholder="留空自动检测：${esc(sys.browsers?.[0]?.path || '未找到 Chrome / Edge')}">
             <datalist id="br-list">${(sys.browsers || []).map((b) => `<option value="${esc(b.path)}">${esc(b.kind)} ${esc(b.version || '')}</option>`).join('')}</datalist>`,
            sys.browser ? `当前使用：${esc(sys.browser.kind === 'edge' ? 'Microsoft Edge' : 'Google Chrome')} ${esc(sys.browser.version || '')} — ${esc(sys.browser.path)}` : `<span style="color:var(--danger)">${esc(sys.browserError || '')}</span>`,
          )}
          ${field(
            '内核',
            `<select class="input" name="kernel">
               <option value="" ${!s.kernel ? 'selected' : ''}>系统 Chrome / Edge（CDP + 脚本注入指纹）</option>
               <option value="sunbrowser" ${s.kernel === 'sunbrowser' ? 'selected' : ''}>AdsPower SunBrowser 内核（内核级指纹）</option>
             </select>`,
            sys.sunBrowser
              ? `已检测到 SunBrowser ${esc(sys.sunBrowser.version)} — ${esc(sys.sunBrowser.path)}`
              : '<span style="color:var(--danger)">未检测到 SunBrowser：需安装 AdsPower 客户端，或下面手动填路径</span>',
          )}
          ${field(
            'SunBrowser 路径',
            `<input class="input mono" name="sunBrowserPath" value="${esc(s.sunBrowserPath || '')}" placeholder="${esc(sys.sunBrowser?.path || '自动检测 %APPDATA%\\adspower_global\\cwd_global\\chrome_*\\sunbrowser.exe')}">`,
            '留空自动检测；SunBrowser 内核下时区 / 经纬度 / Canvas / WebGL / CPU / 内存 / 语言都写进内核配置，不再依赖页面脚本',
          )}
          ${field(
            '界面窗口',
            `<select class="input" name="shell">${[
              ['auto', '自动（Windows 优先 Edge）'],
              ['edge', 'Microsoft Edge'],
              ['chrome', 'Google Chrome'],
              ['browser', '系统默认浏览器（带标签栏）'],
            ]
              .map(([v, l]) => `<option value="${v}" ${(s.shell || 'auto') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}</select>`,
            '管理界面用哪个浏览器开成独立窗口；Windows 自带 Edge，所以不装 Chrome 也能用。',
          )}          ${field('启动页', `<label class="inline"><input type="checkbox" name="showStartPage" ${s.showStartPage ? 'checked' : ''}> 打开环境时显示 IP 与指纹检测页</label>`)}
          <div class="section-title">本地 API</div>
          ${field('API Key', `<div class="inline" style="flex-wrap:nowrap"><input class="input mono" name="apiKey" value="${esc(s.apiKey)}" placeholder="留空 = 不校验"><button type="button" class="btn" id="gen-key">生成</button></div>`, '启用后 /api/v1 接口需带 Authorization: Bearer &lt;key&gt; 或 ?api_key=')}
          ${field('chromedriver', `<input class="input mono" name="chromedriverPath" value="${esc(s.chromedriverPath)}" placeholder="可选，Selenium 使用">`, '作为 /api/v1/browser/start 返回的 webdriver 字段')}
          <div class="section-title">数据</div>
          ${field('数据目录', `<code>${esc(sys.dataDir)}</code>`, '每个环境的浏览器数据保存在 browsers/&lt;环境ID&gt; 下；db.json 保存环境配置')}
          <div class="inline" style="justify-content:flex-end"><button type="submit" class="btn primary">保存设置</button></div>
        </form>
      </div>
    </div>`;
  const f = $('#sf');
  $('#gen-key').onclick = () => setValue(f, 'apiKey', [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', '/internal/settings', { browserPath: formValue(f, 'browserPath'), kernel: formValue(f, 'kernel'), sunBrowserPath: formValue(f, 'sunBrowserPath'), showStartPage: formValue(f, 'showStartPage'), apiKey: formValue(f, 'apiKey'), chromedriverPath: formValue(f, 'chromedriverPath'), shell: formValue(f, 'shell') });
      state.settings = r.settings;
      state.system = r.system;
      renderSideFoot();
      renderSettingsPage();
      toast('已保存', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

// ------------------------------------------------------------------ boot

window.addEventListener('hashchange', route);
setInterval(() => state.page === 'profiles' && renderProfileRows(), 60000); // refresh "x minutes ago"
loadAll()
  .then(() => {
    route();
    connectEvents();
  })
  .catch((e) => {
    $('#main').innerHTML = `<div class="empty"><div class="big">无法连接本地服务</div>${esc(e.message)}</div>`;
  });
