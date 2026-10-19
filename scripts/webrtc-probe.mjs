// Gathers ICE candidates inside a kernel/chrome profile to check WebRTC behaviour.
// node scripts/webrtc-probe.mjs <profileId> <kernel|chrome> [extraArgs comma separated]
import { createApp } from '../src/app.js';

const id = process.argv[2] || 'khkm4wg';
const mode = (process.argv[3] || 'kernel').toLowerCase();
const extra = (process.argv[4] || '').split(',').filter(Boolean);

const app = createApp({ dataDir: './data', port: 0 });
await app.listen(0);
try {
  app.store.updateSettings({ kernel: mode === 'kernel' ? 'sunbrowser' : '' });
  await app.launcher.start(id, { openUrls: ['about:blank'], ipTab: false, extraArgs: extra });
  const conn = app.launcher.running.get(id).conn;
  const { targetInfos } = await conn.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  const expr = `(async () => {
    const out = { candidates: [], counts: {} };
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] });
      pc.createDataChannel('x');
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const c = e.candidate;
        out.candidates.push({ type: c.type, address: c.address || null, port: c.port || null, protocol: c.protocol || null });
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise((r) => setTimeout(r, 4000));
      pc.close();
    } catch (e) { out.error = String(e); }
    for (const c of out.candidates) out.counts[c.type] = (out.counts[c.type] || 0) + 1;
    return JSON.stringify(out);
  })()`;

  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  console.log(`===== ${mode} extra=[${extra.join(' ')}] =====`);
  console.log(r.result.value);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  process.exit(process.exitCode || 0);
}
