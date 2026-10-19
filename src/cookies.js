/**
 * Cookie import/export. The interchange format is the common browser-extension JSON
 * (EditThisCookie / Cookie-Editor / AdsPower): {domain, name, value, path, expirationDate,
 * httpOnly, secure, sameSite, hostOnly, session}. Netscape cookies.txt is accepted on import.
 */

const SAME_SITE_IN = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
const SAME_SITE_OUT = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' };

function parseNetscape(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    }
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , path, secure, expires, name, ...value] = f;
    const exp = Number(expires);
    out.push({ domain, path, secure: secure.toUpperCase() === 'TRUE', httpOnly, name, value: value.join('\t'), expirationDate: exp > 0 ? exp : undefined, session: !(exp > 0), hostOnly: !domain.startsWith('.') });
  }
  return out;
}

/** Parses cookie text (JSON array/object or Netscape format) into the interchange format. */
export function parseCookies(input) {
  if (input === undefined || input === null || input === '') return [];
  let list = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return [];
    if (text.startsWith('[') || text.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Cookie JSON 格式错误: ${e.message}`);
      }
      list = Array.isArray(parsed) ? parsed : parsed.cookies || [parsed];
    } else {
      list = parseNetscape(text);
      if (!list.length) throw new Error('无法识别的 Cookie 格式（支持 JSON 数组或 Netscape cookies.txt）');
    }
  }
  if (!Array.isArray(list)) throw new Error('Cookie 必须是数组');
  return list
    .filter((c) => c && typeof c === 'object' && c.name !== undefined && (c.domain || c.url))
    .map((c) => {
      let domain = c.domain;
      if (!domain && c.url) {
        try {
          domain = new URL(c.url).hostname;
        } catch {
          domain = '';
        }
      }
      let exp = c.expirationDate ?? c.expires ?? c.expiry;
      exp = Number(exp);
      if (exp > 1e11) exp = exp / 1000; // milliseconds
      const session = c.session === true || !(exp > 0);
      return {
        domain: String(domain),
        name: String(c.name),
        value: String(c.value ?? ''),
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: String(c.sameSite || 'unspecified').toLowerCase(),
        hostOnly: c.hostOnly !== undefined ? !!c.hostOnly : !String(domain).startsWith('.'),
        session,
        ...(session ? {} : { expirationDate: exp }),
      };
    })
    .filter((c) => c.domain);
}

/** Interchange format -> CDP Storage.setCookies parameters. */
export function toCdpCookies(list) {
  return list.map((c) => {
    const host = c.domain.replace(/^\./, '');
    const o = { name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
    if (c.hostOnly) o.url = `${c.secure ? 'https' : 'http'}://${host}${o.path}`;
    else o.domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    const ss = SAME_SITE_IN[c.sameSite];
    if (ss) o.sameSite = ss;
    if (ss === 'None') o.secure = true;
    if (!c.session && c.expirationDate > 0) o.expires = c.expirationDate;
    return o;
  });
}

/** CDP Storage.getCookies result -> interchange format. */
export function fromCdpCookies(list) {
  return list.map((c) => ({
    domain: c.domain,
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: SAME_SITE_OUT[c.sameSite] || 'unspecified',
    hostOnly: !c.domain.startsWith('.'),
    session: !!c.session,
    ...(c.session ? {} : { expirationDate: c.expires }),
  }));
}
