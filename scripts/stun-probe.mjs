import dgram from 'node:dgram';
import crypto from 'node:crypto';

const servers = [['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478], ['stun.cloudflare.com', 53]];
for (const [host, port] of servers) {
  const sock = dgram.createSocket('udp4');
  const txid = crypto.randomBytes(12);
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0); // binding request
  req.writeUInt16BE(0x0000, 2);
  req.writeUInt32BE(0x2112a442, 4);
  txid.copy(req, 8);
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    sock.on('message', (msg) => { clearTimeout(timer); resolve(msg); });
    sock.on('error', (e) => { clearTimeout(timer); resolve('error: ' + e.message); });
    sock.send(req, port, host, (e) => { if (e) { clearTimeout(timer); resolve('send error: ' + e.message); } });
  });
  if (typeof res === 'string') { console.log(`${host}:${port} -> ${res}`); }
  else {
    // parse XOR-MAPPED-ADDRESS
    let out = 'response ' + res.length + 'B';
    for (let i = 20; i + 4 <= res.length;) {
      const type = res.readUInt16BE(i); const len = res.readUInt16BE(i + 2);
      if (type === 0x0020) {
        const fam = res.readUInt8(i + 5);
        const xport = res.readUInt16BE(i + 6) ^ 0x2112;
        const ip = [...res.subarray(i + 8, i + 12)].map((b, k) => b ^ [0x21, 0x12, 0xa4, 0x42][k]).join('.');
        out += ` | xor-mapped ${ip}:${xport} (family ${fam})`;
      }
      i += 4 + len + ((4 - (len % 4)) % 4);
    }
    console.log(`${host}:${port} -> ${out}`);
  }
  sock.close();
}
