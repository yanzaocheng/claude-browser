/**
 * Proxy plumbing. Chrome cannot authenticate SOCKS5 proxies and prompts for HTTP proxy
 * credentials, so every profile with a proxy gets a local, credential-free HTTP proxy
 * (127.0.0.1:random) that forwards each connection through the real upstream proxy.
 * DNS is always resolved by the upstream (hostnames are passed on), so it does not leak.
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

export const PROXY_TYPES = ['none', 'http', 'https', 'socks5'];

export function normalizeProxy(p) {
  const type = PROXY_TYPES.includes(p?.type) ? p.type : 'none';
  if (type === 'none') return { type: 'none', host: '', port: 0, username: '', password: '' };
  const port = Number(p.port);
  return {
    type,
    host: String(p.host || '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    username: String(p.username ?? ''),
    password: String(p.password ?? ''),
  };
}

export function hasProxy(p) {
  return !!p && p.type && p.type !== 'none' && p.host && p.port;
}

/**
 * Parses common proxy notations:
 *   socks5://user:pass@host:port   http://host:port   host:port   host:port:user:pass   user:pass@host:port
 */
export function parseProxyString(input, defaultType = 'http') {
  let s = String(input || '').trim();
  if (!s) return null;
  let type = defaultType;
  const m = s.match(/^(https?|socks5h?|socks):\/\//i);
  if (m) {
    type = m[1].toLowerCase().replace(/^socks5h$|^socks$/, 'socks5');
    s = s.slice(m[0].length);
  }
  s = s.replace(/\/+$/, '');
  let username = '';
  let password = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const c = cred.indexOf(':');
    username = decodeURIComponent(c >= 0 ? cred.slice(0, c) : cred);
    password = decodeURIComponent(c >= 0 ? cred.slice(c + 1) : '');
  }
  let host;
  let port;
  const v6 = s.match(/^\[([^\]]+)\]:(\d+)(?::(.*))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2];
  } else {
    const parts = s.split(':');
    if (parts.length < 2) return null;
    [host, port] = parts;
    if (parts.length >= 4 && !username) {
      username = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  const proxy = normalizeProxy({ type, host, port, username, password });
  return proxy.host && proxy.port ? proxy : null;
}

export function formatProxy(p, { withAuth = false } = {}) {
  if (!hasProxy(p)) return '直连';
  const auth = withAuth && p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  const host = net.isIPv6(p.host) ? `[${p.host}]` : p.host;
  return `${p.type}://${auth}${host}:${p.port}`;
}

// ------------------------------------------------------------------ socket helpers

/**
 * Buffered reads during a handshake; release() hands leftover bytes back to the socket.
 * Uses paused mode ('readable' + read()) rather than 'data' events: after an explicit pause()
 * a later on('data') would not resume the stream, which breaks http's createConnection.
 */
class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.err = null;
    this.waiter = null;
    this.onData = () => {
      let chunk;
      while ((chunk = sock.read()) !== null) this.buf = Buffer.concat([this.buf, chunk]);
      this.poll();
    };
    this.onEnd = () => {
      this.err ||= new Error('代理服务器关闭了连接');
      this.poll();
    };
    this.onError = (e) => {
      this.err ||= e;
      this.poll();
    };
    sock.on('readable', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }
  poll() {
    const w = this.waiter;
    if (!w) return;
    const res = w.take();
    if (res !== undefined) {
      this.waiter = null;
      w.resolve(res);
    } else if (this.err) {
      this.waiter = null;
      w.reject(this.err);
    }
  }
  wait(take) {
    return new Promise((resolve, reject) => {
      this.waiter = { take, resolve, reject };
      this.poll();
    });
  }
  read(n) {
    return this.wait(() => {
      if (this.buf.length < n) return undefined;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return out;
    });
  }
  readUntil(delim, max = 64 * 1024) {
    return this.wait(() => {
      const i = this.buf.indexOf(delim);
      if (i < 0) {
        if (this.buf.length > max) this.err ||= new Error('代理响应过长');
        return undefined;
      }
      const out = this.buf.subarray(0, i + delim.length);
      this.buf = this.buf.subarray(i + delim.length);
      return out;
    });
  }
  release() {
    this.sock.off('readable', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    if (this.buf.length) this.sock.unshift(this.buf);
  }
}

function connectTcp(host, port, { secure = false, servername } = {}) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: servername || (net.isIP(host) ? undefined : host), ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    const onErr = (e) => {
      sock.destroy();
      reject(e);
    };
    sock.once('error', onErr);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.off('error', onErr);
      sock.setNoDelay(true);
      resolve(sock);
    });
  });
}

function ipv6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.flatMap((g) => {
    const v = parseInt(g || '0', 16);
    return [v >> 8, v & 0xff];
  });
}

const SOCKS_ERRORS = {
  1: '一般性失败',
  2: '规则不允许连接',
  3: '网络不可达',
  4: '主机不可达',
  5: '连接被拒绝',
  6: 'TTL 过期',
  7: '不支持的命令',
  8: '不支持的地址类型',
};

async function socks5Handshake(sock, proxy, host, port) {
  const r = new Reader(sock);
  try {
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const [ver, method] = await r.read(2);
    if (ver !== 0x05) throw new Error('不是有效的 SOCKS5 代理');
    if (method === 0x02) {
      const u = Buffer.from(proxy.username);
      const p = Buffer.from(proxy.password || '');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await r.read(2);
      if (status !== 0x00) throw new Error('SOCKS5 代理认证失败（用户名或密码错误）');
    } else if (method !== 0x00) {
      throw new Error(proxy.username ? 'SOCKS5 代理不接受用户名密码认证' : 'SOCKS5 代理需要认证');
    }
    let addr;
    const ipType = net.isIP(host);
    if (ipType === 4) addr = [0x01, ...host.split('.').map(Number)];
    else if (ipType === 6) addr = [0x04, ...ipv6Bytes(host)];
    else {
      const hb = Buffer.from(host);
      addr = [0x03, hb.length, ...hb];
    }
    sock.write(Buffer.from([0x05, 0x01, 0x00, ...addr, port >> 8, port & 0xff]));
    const head = await r.read(4);
    if (head[1] !== 0x00) throw new Error(`SOCKS5 连接目标失败: ${SOCKS_ERRORS[head[1]] || head[1]}`);
    const len = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : (await r.read(1))[0];
    await r.read(len + 2);
  } finally {
    r.release();
  }
}

async function httpConnectHandshake(sock, proxy, host, port) {
  const r = new Reader(sock);
  try {
    const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
    if (proxy.username) req += `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
    sock.write(`${req}\r\n`);
    const head = (await r.readUntil('\r\n\r\n')).toString('latin1');
    const status = Number(head.split(' ')[1]);
    if (status === 407) throw new Error('HTTP 代理认证失败 (407)');
    if (status < 200 || status > 299) throw new Error(`HTTP 代理拒绝连接 (${head.split('\r\n')[0]})`);
  } finally {
    r.release();
  }
}

/** Opens a raw TCP stream to host:port, through the proxy when one is given. */
export async function openTunnel(proxy, host, port, { timeout = 15000 } = {}) {
  host = host.replace(/^\[|\]$/g, '');
  if (!hasProxy(proxy)) return connectTcp(host, port);
  let sock;
  let connecting;
  const timer = setTimeout(() => sock?.destroy(new Error('代理握手超时')), timeout);
  try {
    connecting = connectTcp(proxy.host, proxy.port, { secure: proxy.type === 'https' });
    sock = await Promise.race([connecting, new Promise((_, rej) => setTimeout(() => rej(proxyError('连接代理服务器超时')), timeout))]);
    if (proxy.type === 'socks5') await socks5Handshake(sock, proxy, host, port);
    else await httpConnectHandshake(sock, proxy, host, port);
    return sock;
  } catch (err) {
    sock?.destroy();
    connecting?.then((s) => s.destroy(), () => {});
    if (err.code === 'ECONNREFUSED') throw proxyError(`无法连接代理服务器 ${proxy.host}:${proxy.port}（连接被拒绝）`);
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw proxyError(`代理服务器地址无法解析: ${proxy.host}`);
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /认证|SOCKS5 代理|不是有效/.test(err.message)) err.proxyError = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** An error about the proxy server itself (as opposed to the target behind it). */
function proxyError(message) {
  const e = new Error(message);
  e.proxyError = true;
  return e;
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'upgrade']);

function cleanHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (!HOP_HEADERS.has(rawHeaders[i].toLowerCase())) out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

/**
 * Requests `url` through `proxy`. Plain-HTTP targets behind an HTTP proxy are sent in
 * absolute-URI form (many HTTP proxies only allow CONNECT to 443); everything else is tunnelled.
 */
export function proxiedRequest(proxy, url, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const hdrs = { host: u.host, 'user-agent': 'Mozilla/5.0', accept: '*/*', connection: 'close', ...headers };
  let opts;
  if (!isHttps && hasProxy(proxy) && proxy.type !== 'socks5') {
    if (proxy.username) hdrs['proxy-authorization'] = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    opts = { host: proxy.host, port: proxy.port, path: u.href, method, headers: hdrs };
    if (proxy.type === 'https') opts.servername = net.isIP(proxy.host) ? undefined : proxy.host;
  } else {
    opts = {
      method,
      path: u.pathname + u.search,
      headers: hdrs,
      createConnection: (_o, cb) => {
        openTunnel(proxy, u.hostname, port, { timeout }).then(
          (sock) => {
            if (!isHttps) return cb(null, sock);
            const t = tls.connect({ socket: sock, servername: net.isIP(u.hostname) ? undefined : u.hostname, ALPNProtocols: ['http/1.1'] });
            t.once('secureConnect', () => cb(null, t));
            t.once('error', (e) => cb(e));
          },
          (err) => cb(err),
        );
      },
    };
  }
  const mod = opts.createConnection || proxy?.type !== 'https' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) req.destroy(new Error('响应过大'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

// ------------------------------------------------------------------ local forwarder

/** Starts a local HTTP proxy on 127.0.0.1 that forwards everything through `upstream`. */
export function startForwarder(upstream) {
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };
  const stats = { connections: 0, errors: 0, lastError: null };
  const fail = (err) => {
    stats.errors++;
    stats.lastError = err.message;
  };

  const server = http.createServer((req, res) => {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (u.protocol !== 'http:') {
      res.writeHead(400).end('Unsupported protocol');
      return;
    }
    stats.connections++;
    const port = Number(u.port) || 80;
    const headers = cleanHeaders(req.rawHeaders);
    let opts;
    if (upstream.type === 'socks5') {
      opts = {
        method: req.method,
        path: u.pathname + u.search,
        headers,
        // must not return the promise: http treats any truthy return value as the socket
        createConnection: (_o, cb) => {
          openTunnel(upstream, u.hostname, port).then((s) => cb(null, s), cb);
        },
      };
    } else {
      if (upstream.username) headers.push('Proxy-Authorization', `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}`);
      opts = { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers };
    }
    const mod = upstream.type === 'https' ? https : http;
    const preq = mod.request(opts, (pres) => {
      res.writeHead(pres.statusCode, pres.statusMessage, cleanHeaders(pres.rawHeaders));
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    });
    preq.on('error', (err) => {
      fail(err);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`代理错误: ${err.message}`);
      else res.destroy();
    });
    req.pipe(preq);
  });

  server.on('connect', (req, client, head) => {
    track(client);
    stats.connections++;
    client.on('error', () => {});
    const m = req.url.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    openTunnel(upstream, m[1], Number(m[2])).then(
      (up) => {
        track(up);
        if (client.destroyed) return up.destroy();
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
        client.on('close', () => up.destroy());
        up.on('close', () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      },
      (err) => {
        fail(err);
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      },
    );
  });
  server.on('connection', track);
  server.on('clientError', (_e, s) => s.destroy());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}
