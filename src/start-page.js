const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const flagEmoji = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

/** The first tab of every profile: who am I, which IP, and what sites see (measured live). */
export function renderStartPage(profile, info, group) {
  const ip = info?.ipInfo;
  const proxy = profile.proxy?.type && profile.proxy.type !== 'none' ? `${profile.proxy.type}://${profile.proxy.host}:${profile.proxy.port}` : '直连（未使用代理）';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>#${esc(profile.serial)} ${esc(profile.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f3f5f9;color:#1f2937}
.wrap{max-width:980px;margin:32px auto;padding:0 20px}
.hero{background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;border-radius:14px;padding:26px 30px;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.hero h1{margin:0 0 4px;font-size:24px}.hero .sub{opacity:.85}
.ip{font-size:30px;font-weight:700;letter-spacing:.5px}.ip small{display:block;font-size:14px;font-weight:400;opacity:.9;text-align:right}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.card{background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h2{font-size:15px;margin:0 0 10px;color:#374151}
table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #f0f2f5;vertical-align:top;word-break:break-all}
td:first-child{color:#6b7280;width:120px;white-space:nowrap;padding-right:10px}tr:last-child td{border-bottom:0}
.full{grid-column:1/-1}.ok{color:#059669}.warn{color:#d97706}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div class="hero"><div><h1>#${esc(profile.serial)} · ${esc(profile.name)}</h1>
<div class="sub">分组：${esc(group?.name || '未分组')} · 环境 ID：${esc(profile.id)}</div>
<div class="sub">代理：${esc(proxy)}</div></div>
<div class="ip">${ip ? `${flagEmoji(ip.countryCode)} ${esc(ip.ip)}<small>${esc([ip.country, ip.region, ip.city].filter(Boolean).join(' · '))}</small>` : '<small>未获取到出口 IP</small>'}</div></div>
<div class="grid">
<div class="card"><h2>出口 IP 信息</h2><table>
<tr><td>IP</td><td>${esc(ip?.ip || '-')}</td></tr>
<tr><td>国家/地区</td><td>${esc(ip ? `${ip.country || ''} (${ip.countryCode || ''})` : '-')}</td></tr>
<tr><td>城市</td><td>${esc(ip ? [ip.region, ip.city].filter(Boolean).join(' / ') : '-')}</td></tr>
<tr><td>IP 时区</td><td>${esc(ip?.timezone || '-')}</td></tr>
<tr><td>坐标</td><td>${esc(ip && Number.isFinite(ip.lat) ? `${ip.lat}, ${ip.lon}` : '-')}</td></tr>
<tr><td>数据来源</td><td>${esc(ip?.source || '-')}</td></tr>
</table></div>
<div class="card"><h2>浏览器环境（页面实测）</h2><table id="env"></table></div>
<div class="card full"><h2>User-Agent / 图形</h2><table id="ua"></table></div>
</div></div>
<script>
(async () => {
  const row = (t, k, v, cls) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; const b = document.createElement('td'); b.textContent = v; if (cls) b.className = cls; tr.append(a, b); document.getElementById(t).append(tr); };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ipTz = ${JSON.stringify(ip?.timezone || '').replace(/</g, '\\u003c')};
  row('env', '时区', tz + (ipTz ? (tz === ipTz ? '  ✓ 与 IP 一致' : '  ✗ 与 IP 不一致') : ''), ipTz ? (tz === ipTz ? 'ok' : 'warn') : '');
  row('env', '本地时间', new Date().toLocaleString());
  row('env', '语言', navigator.languages.join(', '));
  row('env', '屏幕', screen.width + ' × ' + screen.height + ' (DPR ' + devicePixelRatio + ')');
  row('env', 'CPU 核心', navigator.hardwareConcurrency);
  row('env', '内存', (navigator.deviceMemory || '-') + ' GB');
  row('env', 'WebRTC', typeof RTCPeerConnection === 'function' ? '已启用（受策略保护）' : '已禁用');
  row('env', 'webdriver', String(navigator.webdriver), navigator.webdriver ? 'warn' : 'ok');
  row('ua', 'User-Agent', navigator.userAgent);
  row('ua', 'Platform', navigator.platform);
  if (navigator.userAgentData) {
    const h = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList']);
    row('ua', 'Client Hints', navigator.userAgentData.brands.map(b => b.brand + ' ' + b.version).join(', ') + ' · ' + navigator.userAgentData.platform + ' ' + h.platformVersion);
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    row('ua', 'WebGL 厂商', gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
    row('ua', 'WebGL 渲染器', gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch (e) { row('ua', 'WebGL', '不可用'); }
  const c = document.createElement('canvas'); c.width = 240; c.height = 60; const x = c.getContext('2d');
  x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20); x.fillStyle = '#069'; x.fillText('Claude Browser 指纹 😃', 2, 15);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.toDataURL()));
  row('ua', 'Canvas 哈希', [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''));
})();
</script></body></html>`;
}
