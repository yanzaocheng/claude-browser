import { EventEmitter } from 'node:events';

export class CDPError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}`);
    this.code = error.code;
  }
}

/** A flattened CDP session (one attached target) multiplexed over the browser connection. */
export class CDPSession extends EventEmitter {
  constructor(conn, id, targetInfo, parent) {
    super();
    this.conn = conn;
    this.id = id;
    this.targetInfo = targetInfo;
    this.parent = parent;
    this.detached = false;
  }
  send(method, params) {
    if (this.detached) return Promise.reject(new Error(`${method}: session detached`));
    return this.conn.send(method, params, this.id);
  }
}

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
export class CDPConnection extends EventEmitter {
  static connect(url, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('连接 DevTools 超时'));
      }, timeout);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CDPConnection(ws, url));
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`连接 DevTools 失败: ${e.message || url}`));
      };
    });
  }

  constructor(ws, url) {
    super();
    this.ws = ws;
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.closed = false;
    ws.onmessage = (e) => this._onMessage(e.data);
    ws.onclose = () => this._onClose();
    ws.onerror = () => {};
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
      this.ws.send(JSON.stringify(msg));
    });
  }

  session(id) {
    return this.sessions.get(id) || null;
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CDPError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    const { method, params } = msg;
    let attached = null;
    if (method === 'Target.attachedToTarget') {
      const parent = msg.sessionId ? this.sessions.get(msg.sessionId) : null;
      attached = new CDPSession(this, params.sessionId, params.targetInfo, parent);
      this.sessions.set(params.sessionId, attached);
    } else if (method === 'Target.detachedFromTarget') {
      const s = this.sessions.get(params.sessionId);
      if (s) {
        s.detached = true;
        this.sessions.delete(params.sessionId);
        for (const [id, p] of this.pending) {
          if (p.sessionId === params.sessionId) {
            this.pending.delete(id);
            p.reject(new Error(`${p.method}: target detached`));
          }
        }
        s.emit('detached');
      }
    }
    const emitter = msg.sessionId ? this.sessions.get(msg.sessionId) : this;
    if (emitter) emitter.emit(method, params);
    if (attached) this.emit('attached', attached, params);
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(`${p.method}: connection closed`));
    this.pending.clear();
    this.emit('close');
  }

  close() {
    try {
      this.ws.close();
    } catch {}
    this._onClose();
  }
}
