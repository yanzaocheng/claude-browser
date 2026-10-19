import { proxiedRequest } from './proxy-chain.js';

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

const PROVIDERS = [
  {
    url: 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,query',
    parse: (j) =>
      j.status === 'success'
        ? { ip: j.query, country: j.country, countryCode: j.countryCode, region: j.regionName, city: j.city, lat: num(j.lat), lon: num(j.lon), timezone: j.timezone }
        : null,
  },
  {
    url: 'https://ipinfo.io/json',
    parse: (j) => {
      if (!j.ip) return null;
      const [lat, lon] = String(j.loc || '').split(',');
      return { ip: j.ip, country: j.country, countryCode: j.country, region: j.region, city: j.city, lat: num(lat), lon: num(lon), timezone: j.timezone };
    },
  },
  {
    url: 'https://ipwho.is/',
    parse: (j) =>
      j.success
        ? { ip: j.ip, country: j.country, countryCode: j.country_code, region: j.region, city: j.city, lat: num(j.latitude), lon: num(j.longitude), timezone: j.timezone?.id }
        : null,
  },
];

/**
 * Looks up the exit IP (and its country / timezone / coordinates) as seen through `proxy`.
 * Tries several providers; stops early when the proxy itself is broken.
 */
export async function lookupIp(proxy, { timeout = 8000, providers = PROVIDERS } = {}) {
  const errors = [];
  for (const p of providers) {
    const host = new URL(p.url).host;
    try {
      const res = await proxiedRequest(proxy, p.url, { timeout, headers: { accept: 'application/json' } });
      if (res.status === 407) {
        const e = new Error('HTTP 代理认证失败 (407)');
        e.proxyError = true;
        throw e;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const info = p.parse(JSON.parse(res.body));
      if (!info?.ip) throw new Error('无效响应');
      return { ...info, source: host, checkedAt: Date.now() };
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
      if (e.proxyError || e.code === 'ECONNREFUSED') {
        const err = new Error(e.message);
        err.proxyError = true;
        throw err;
      }
    }
  }
  throw new Error(`IP 查询失败 (${errors.join('; ')})`);
}
