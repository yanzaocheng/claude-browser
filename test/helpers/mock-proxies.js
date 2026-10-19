// Mock upstream proxies for tests. Hostnames ending in `.test` are routed to the local target
// server, so nothing here needs network access.
import net from 'node:net';
import http from 'node:http';

const resolveHost = (host, map) => map[host] || host;

/** HTTP proxy with Basic auth supporting absolute-URI requests and CONNECT. */
export function startHttpProxy({ username, password, hosts = {} }) {
  const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url });
    if (req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="x"' }).end();
      return;
    }
    const u = new URL(req.url);
    const [host, port] = resolveHost(`${u.hostname}:${u.port || 80}`, hosts).split(':');
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const preq = http.request({ host, port, method: req.method, path: u.pathname + u.search, headers }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => res.writeHead(502).end());
    req.pipe(preq);
  });
  server.on('connect', (req, client, head) => {
    log.push({ method: 'CONNECT', url: req.url });
    client.on('error', () => {});
    if (req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = resolveHost(req.url, hosts).split(':');
    const up = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
  });
  return listen(server, log);
}

/** SOCKS5 proxy with username/password auth (RFC 1928 / 1929). */
export function startSocks5Proxy({ username, password, hosts = {} }) {
  const log = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(0x02)) {
          sock.end(Buffer.from([0x05, 0xff]));
          return;
        }
        sock.write(Buffer.from([0x05, 0x02]));
        stage = 'auth';
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 2 + ul + 1) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString();
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== username || p !== password) {
          sock.end(Buffer.from([0x01, 0x01]));
          return;
        }
        sock.write(Buffer.from([0x01, 0x00]));
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5) {
        const atyp = buf[3];
        let host;
        let off;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join('.');
          off = 8;
        } else if (atyp === 0x03) {
          const l = buf[4];
          if (buf.length < 5 + l + 2) return;
          host = buf.subarray(5, 5 + l).toString();
          off = 5 + l;
        } else {
          sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 'done';
        sock.off('data', onData);
        log.push({ host, port });
        const [h, pt] = resolveHost(`${host}:${port}`, hosts).split(':');
        const up = net.connect(Number(pt), h, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(sock);
          sock.pipe(up);
        });
        up.on('error', () => sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
        sock.on('close', () => up.destroy());
      }
    };
    sock.on('data', onData);
  });
  return listen(server, log);
}

function listen(server, log) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const sockets = new Set();
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      resolve({
        port: server.address().port,
        log,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

/** Plain HTTP server standing in for "the internet": an echo page and a fake ip-api.com. */
export function startTargetServer({ ipInfo } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ url: req.url, headers: req.headers });
    if (req.url === '/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(
        'postMessage({ hc: navigator.hardwareConcurrency, ua: navigator.userAgent, platform: navigator.platform, langs: navigator.languages, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ts: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, "hardwareConcurrency").get) })',
      );
      return;
    }
    const probe = '({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, langs: navigator.languages, hc: navigator.hardwareConcurrency, mem: navigator.deviceMemory, ua: navigator.userAgent, platform: navigator.platform })';
    if (req.url === '/shared.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`onconnect = (e) => e.ports[0].postMessage(${probe});`);
      return;
    }
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('message', (e) => e.source.postMessage(${probe}));`);
      return;
    }
    if (req.url.startsWith('/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ipInfo || { status: 'success', query: '203.0.113.7', country: 'Japan', countryCode: 'JP', regionName: 'Tokyo', city: 'Tokyo', lat: 35.68, lon: 139.69, timezone: 'Asia/Tokyo' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>target</title><body>via-proxy ${req.headers['user-agent'] || ''}</body>`);
  });
  return listen(server, log);
}
