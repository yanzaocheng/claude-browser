import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseProxyString, proxiedRequest, startForwarder, openTunnel, formatProxy } from '../src/proxy-chain.js';
import { lookupIp } from '../src/ipinfo.js';
import { startHttpProxy, startSocks5Proxy, startTargetServer } from './helpers/mock-proxies.js';

let target, httpProxy, socksProxy;

before(async () => {
  target = await startTargetServer();
  // the test machine may resolve every name (fake-IP DNS), so unreachable targets map to a closed local port
  const closed = net.createServer().listen(0);
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const hosts = { 'target.test:80': `127.0.0.1:${target.port}`, 'ip-api.com:80': `127.0.0.1:${target.port}`, 'dead.test:1': `127.0.0.1:${deadPort}` };
  httpProxy = await startHttpProxy({ username: 'alice', password: 'p@ss:1', hosts });
  socksProxy = await startSocks5Proxy({ username: 'bob', password: 'secret', hosts });
});
after(async () => {
  await Promise.all([target.close(), httpProxy.close(), socksProxy.close()]);
});

const httpUp = () => ({ type: 'http', host: '127.0.0.1', port: httpProxy.port, username: 'alice', password: 'p@ss:1' });
const socksUp = () => ({ type: 'socks5', host: '127.0.0.1', port: socksProxy.port, username: 'bob', password: 'secret' });

test('parseProxyString understands the usual notations', () => {
  assert.deepEqual(parseProxyString('socks5://u:p%40x@1.2.3.4:1080'), { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p@x' });
  assert.deepEqual(parseProxyString('1.2.3.4:8080'), { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(parseProxyString('proxy.example.com:8000:user:pa:ss', 'socks5'), { type: 'socks5', host: 'proxy.example.com', port: 8000, username: 'user', password: 'pa:ss' });
  assert.deepEqual(parseProxyString('user:pw@host.example:3128'), { type: 'http', host: 'host.example', port: 3128, username: 'user', password: 'pw' });
  assert.equal(parseProxyString('socks5h://h:1').type, 'socks5');
  assert.equal(parseProxyString('nonsense'), null);
  assert.equal(formatProxy({ type: 'http', host: 'h', port: 1, username: 'a', password: 'b' }, { withAuth: true }), 'http://a:b@h:1');
});

test('proxiedRequest through an HTTP proxy uses absolute-URI form with credentials', async () => {
  const res = await proxiedRequest(httpUp(), 'http://target.test/hello');
  assert.equal(res.status, 200);
  assert.match(res.body, /via-proxy/);
  assert.ok(httpProxy.log.some((l) => l.method === 'GET' && l.url === 'http://target.test/hello'));
  const bad = await proxiedRequest({ ...httpUp(), password: 'wrong' }, 'http://target.test/');
  assert.equal(bad.status, 407);
});

test('proxiedRequest through SOCKS5 resolves the hostname remotely', async () => {
  const res = await proxiedRequest(socksUp(), 'http://target.test/x');
  assert.equal(res.status, 200);
  assert.ok(socksProxy.log.some((l) => l.host === 'target.test' && l.port === 80));
});

test('SOCKS5 auth failure is reported as a proxy error', async () => {
  await assert.rejects(openTunnel({ ...socksUp(), password: 'nope' }, 'target.test', 80), (e) => e.proxyError && /认证失败/.test(e.message));
});

test('connection refused is reported as a proxy error', async () => {
  const srv = net.createServer().listen(0);
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  await assert.rejects(openTunnel({ type: 'socks5', host: '127.0.0.1', port }, 'target.test', 80), (e) => e.proxyError);
});

test('lookupIp parses the provider response seen through the proxy', async () => {
  for (const up of [httpUp(), socksUp()]) {
    const info = await lookupIp(up);
    assert.equal(info.ip, '203.0.113.7');
    assert.equal(info.countryCode, 'JP');
    assert.equal(info.timezone, 'Asia/Tokyo');
    assert.equal(info.lat, 35.68);
  }
  await assert.rejects(lookupIp({ ...httpUp(), password: 'x' }), (e) => e.proxyError);
});

function viaForwarder(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers: { host: 'target.test' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function connectViaForwarder(port, hostport) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: hostport });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`));
      sock.write('GET /tunnel HTTP/1.1\r\nHost: target.test\r\nConnection: close\r\n\r\n');
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const [name, up] of [['HTTP', httpUp], ['SOCKS5', socksUp]]) {
  test(`local forwarder chains plain HTTP and CONNECT through ${name} upstream`, async () => {
    const fwd = await startForwarder(up());
    try {
      const res = await viaForwarder(fwd.port, 'http://target.test/plain');
      assert.equal(res.status, 200);
      assert.match(res.body, /via-proxy/);
      const raw = await connectViaForwarder(fwd.port, 'target.test:80');
      assert.match(raw, /^HTTP\/1\.1 200/);
      assert.match(raw, /via-proxy/);
      const bad = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: fwd.port, method: 'CONNECT', path: 'dead.test:1' });
        req.on('connect', (res) => resolve(res.statusCode));
        req.on('error', () => resolve('error'));
        req.end();
      });
      assert.equal(bad, 502);
    } finally {
      await fwd.close();
    }
  });
}
