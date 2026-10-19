/**
 * Fingerprint patches that cannot be done through CDP Emulation. Injected into every page,
 * frame and worker before site scripts run.
 *
 * The function is serialized with toString(), so it must not reference anything outside itself.
 * Design rules:
 *  - a replaced function is an ordinary method, not a Proxy (prototype-cycle checks expose Proxies),
 *    with the native name/length/[[Prototype]], native-looking source, native receiver checks
 *    ("Illegal invocation"), and errors thrown through it carry the caller's stack only;
 *  - noise is deterministic per profile (seeded) and idempotent (forcing low bits instead of
 *    adding deltas), so repeated reads and doubly patched realms return identical values. It only
 *    touches what fingerprinting produces (anti-aliased pixels, rendered audio, fractional rects),
 *    so "write known values, read them back" traps see exact values;
 *  - about:blank / srcdoc frames do not get CDP init scripts, so child realms are patched from the
 *    parent as soon as they become reachable (contentWindow, DOM insertion, parser via MutationObserver).
 */
export function spoof(cfg) {
  'use strict';
  try {
    const R = Reflect;
    const rApply = R.apply;
    const rGOPD = R.getOwnPropertyDescriptor;
    const rDefine = R.defineProperty;
    const getProto = Object.getPrototypeOf;
    const setProto = Object.setPrototypeOf;
    const ErrorCtor = Error;
    const captureStackTrace = Error.captureStackTrace;
    const symToStringTag = Symbol.toStringTag;
    const strSplit = String.prototype.split;
    const arrJoin = Array.prototype.join;
    const promiseThen = Promise.prototype.then;
    const U32 = Uint32Array;
    const wmGet = WeakMap.prototype.get;
    const wmSet = WeakMap.prototype.set;
    const wmHas = WeakMap.prototype.has;
    const wmDelete = WeakMap.prototype.delete;
    const wsHas = WeakSet.prototype.has;
    const wsAdd = WeakSet.prototype.add;
    const imul = Math.imul;
    const mRound = Math.round;
    const mMin = Math.min;
    const mMax = Math.max;

    const masks = new WeakMap(); // replacement function -> native source text
    const realms = new WeakSet(); // realm Object constructors already patched
    const foreign = new WeakSet(); // cross-origin WindowProxies (never patchable)
    const ctxTypes = new WeakMap(); // canvas -> context type it was created with
    const noisedAudio = new WeakSet();
    const renderedAudio = new WeakSet(); // AudioBuffers produced by OfflineAudioContext rendering
    const seed = cfg.seed >>> 0;

    const isMasked = (f) => rApply(wmHas, masks, [f]);

    const hash = (a, b, c) => {
      let h = seed ^ imul(a | 0, 0x9e3779b1) ^ imul(b | 0, 0x85ebca77) ^ imul(c | 0, 0xc2b2ae3d);
      h ^= h >>> 16;
      h = imul(h, 0x7feb352d);
      h ^= h >>> 15;
      h = imul(h, 0x846ca68b);
      h ^= h >>> 16;
      return h >>> 0;
    };

    // Forces the lowest bit of one channel of ~1/32 of the anti-aliased (semi-transparent) pixels
    // (idempotent). Fingerprinting draws text and curves whose edges are semi-transparent; solid
    // pixels stay exact, so pixel read-back traps (random opaque 1x1 fills) find nothing.
    const noisePixels = (data, w, h, x0, y0) => {
      const n = mMin(data.length >> 2, w * h);
      for (let k = 0; k < n; k++) {
        const i = k << 2;
        const a = data[i + 3];
        if (a === 0 || a === 255) continue;
        const r = hash((k % w) + x0, ((k / w) | 0) + y0, 0x51);
        if ((r & 31) !== 0) continue;
        const c = i + ((r >>> 5) % 3);
        data[c] = (data[c] & 0xfe) | ((r >>> 8) & 1);
      }
    };

    // Forces the lowest mantissa bit of ~1/16 of the non-zero float32 samples (idempotent).
    const noiseFloats = (arr, salt) => {
      const u = new U32(arr.buffer, arr.byteOffset, arr.length);
      const n = u.length;
      for (let i = 0; i < n; i++) {
        if ((u[i] & 0x7fffffff) === 0) continue;
        const r = hash(i, salt, 0x77);
        if ((r & 15) !== 0) continue;
        u[i] = (u[i] & 0xfffffffe) | ((r >>> 4) & 1);
      }
    };

    // Tiny positive offset on a 1/64px grid (idempotent). Integers stay exact: a 100px box must
    // measure 100, only text-driven fractional sizes vary.
    const fixRect = (v, salt) => {
      if (v !== v || v === Infinity || v === -Infinity || v % 1 === 0) return v;
      const base = mRound(v * 64);
      return base / 64 + ((hash(base, salt, 0x99) % 997) + 1) * 1e-6;
    };

    const install = (g) => {
      let key;
      try {
        if (rApply(wsHas, foreign, [g])) return;
        key = g.Object;
      } catch (e) {
        try {
          rApply(wsAdd, foreign, [g]);
        } catch (e2) {}
        return;
      }
      if (!key || rApply(wsHas, realms, [key])) return;
      rApply(wsAdd, realms, [key]);

      const safe = (f) => {
        try {
          f();
        } catch (e) {}
      };
      const isWindow = !!g.document;
      const FP = g.Function.prototype;
      const tsDesc = rGOPD(FP, 'toString');
      const realmToString = tsDesc.value;
      const sourceOf = (fn) => (isMasked(fn) ? rApply(wmGet, masks, [fn]) : rApply(realmToString, fn, []));

      // Native code adds no stack frames, so an error thrown through a stand-in gets the stack as
      // seen from its caller. `fix` can then add back a builtin frame (Function.prototype.toString).
      const cleanStack = (e, w, fix, self) => {
        if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return;
        try {
          rApply(captureStackTrace, ErrorCtor, [e, w]);
          if (fix) fix(e, self);
        } catch (x) {}
      };

      // Stand-in for the native `fn`: `impl(fn, this, args)` does the work.
      const wrap = (fn, impl, fix) => {
        const name = fn.name;
        const w = {
          [name](...args) {
            try {
              return impl(fn, this, args);
            } catch (e) {
              cleanStack(e, w, fix, this);
              throw e;
            }
          },
        }[name];
        rDefine(w, 'length', { value: fn.length, writable: false, enumerable: false, configurable: true });
        const p = getProto(fn);
        if (getProto(w) !== p) setProto(w, p);
        rApply(wmSet, masks, [w, sourceOf(fn)]);
        return w;
      };

      // V8 shows the builtin frame "at <Type>.toString (<anonymous>)" when toString rejects its receiver;
      // the type is the receiver's constructor name (else its @@toStringTag).
      const typeName = (v) => {
        if (v === null || v === undefined) return '';
        const t = typeof v;
        if (t === 'number') return 'Number';
        if (t === 'string') return 'String';
        if (t === 'boolean') return 'Boolean';
        if (t === 'symbol') return 'Symbol';
        if (t === 'bigint') return 'BigInt';
        let ctor = '';
        let tag = '';
        for (let o = v, i = 0; o !== null && o !== undefined && i < 64 && !(ctor && tag); i++, o = getProto(o)) {
          if (!ctor) {
            const d = rGOPD(o, 'constructor');
            const nd = d && typeof d.value === 'function' ? rGOPD(d.value, 'name') : null;
            if (nd && typeof nd.value === 'string') ctor = nd.value;
          }
          if (!tag) {
            const d = rGOPD(o, symToStringTag);
            if (d && typeof d.value === 'string') tag = d.value;
          }
        }
        if (ctor && ctor !== 'Object') return ctor;
        return tag || ctor || (t === 'function' ? 'Function' : 'Object');
      };
      const toStringFrame = (e, self) => {
        const E = g.Error;
        if (typeof E.prepareStackTrace === 'function' || typeof ErrorCtor.prepareStackTrace === 'function') return;
        const s = e.stack;
        if (typeof s !== 'string') return;
        const tn = typeName(self);
        const lines = rApply(strSplit, s, ['\n']);
        const frame = `    at ${tn ? `${tn}.` : ''}toString (<anonymous>)`;
        const out = [lines[0], frame];
        for (let i = 1; i < lines.length; i++) out[out.length] = lines[i];
        const lim = E.stackTraceLimit;
        if (typeof lim === 'number' && lim >= 0 && out.length > lim + 1) out.length = lim + 1;
        e.stack = rApply(arrJoin, out, ['\n']);
      };
      rDefine(FP, 'toString', {
        ...tsDesc,
        value: wrap(realmToString, (t, self, args) => (isMasked(self) ? rApply(wmGet, masks, [self]) : rApply(t, self, args)), toStringFrame),
      });

      const hookGetter = (obj, prop, fn) => {
        const d = obj && rGOPD(obj, prop);
        if (!d || typeof d.get !== 'function') return;
        rDefine(obj, prop, { ...d, get: wrap(d.get, (t, self, args) => fn(rApply(t, self, args), self)) });
      };
      const hookSetter = (obj, prop, after) => {
        const d = obj && rGOPD(obj, prop);
        if (!d || typeof d.set !== 'function') return;
        rDefine(obj, prop, {
          ...d,
          set: wrap(d.set, (t, self, args) => {
            const r = rApply(t, self, args);
            after();
            return r;
          }),
        });
      };
      const hookMethod = (obj, prop, apply) => {
        const d = obj && rGOPD(obj, prop);
        if (!d || typeof d.value !== 'function') return;
        rDefine(obj, prop, { ...d, value: wrap(d.value, apply) });
      };
      const proto = (name) => (g[name] && g[name].prototype) || null;
      const getterOf = (P, prop) => (P && rGOPD(P, prop)) || {};

      // ---------------------------------------------------------- navigator
      const NavP = proto('Navigator') || proto('WorkerNavigator');
      if (cfg.deviceMemory) safe(() => hookGetter(NavP, 'deviceMemory', () => cfg.deviceMemory));
      // Chrome reports webdriver=true whenever remote debugging is on, which is how we drive it
      safe(() => hookGetter(NavP, 'webdriver', () => false));
      // the CDP platform override only reaches the first page of a renderer process
      if (cfg.platform) safe(() => hookGetter(NavP, 'platform', (v) => (v === cfg.platform ? v : cfg.platform)));
      if (!isWindow && cfg.worker) {
        const w = cfg.worker;
        safe(() => {
          if (w.hardwareConcurrency) hookGetter(NavP, 'hardwareConcurrency', () => w.hardwareConcurrency);
          if (w.userAgent) {
            hookGetter(NavP, 'userAgent', () => w.userAgent);
            hookGetter(NavP, 'appVersion', () => w.appVersion);
          }
        });
      }

      // ---------------------------------------------------------- screen work area + window position
      // CDP overrides only width/height; the work area (taskbar / menu bar) and the window position
      // must agree with the spoofed screen, else e.g. screenX + outerWidth > screen.width.
      if (isWindow && cfg.screen) {
        safe(() => {
          const sc = cfg.screen;
          const S = proto('Screen');
          for (const k of ['availWidth', 'availHeight', 'availLeft', 'availTop']) hookGetter(S, k, () => sc[k]);
          const ow = getterOf(g, 'outerWidth').get;
          const oh = getterOf(g, 'outerHeight').get;
          const clampX = (v) => mMax(sc.availLeft, mMin(v, sc.availLeft + sc.availWidth - rApply(ow, g, [])));
          const clampY = (v) => mMax(sc.availTop, mMin(v, sc.availTop + sc.availHeight - rApply(oh, g, [])));
          hookGetter(g, 'screenX', clampX);
          hookGetter(g, 'screenLeft', clampX);
          hookGetter(g, 'screenY', clampY);
          hookGetter(g, 'screenTop', clampY);
        });
      }

      // ---------------------------------------------------------- speech voices
      // Local voices reveal the real OS language (e.g. Chinese voices behind a ja-JP profile).
      // Replace them with the voices of the profile's OS + language; keep the browser's remote ones.
      if (isWindow && cfg.voices) {
        safe(() => {
          const SV = proto('SpeechSynthesisVoice');
          const SS = proto('SpeechSynthesis');
          if (!SV || !SS) return;
          const fakes = new WeakMap(); // fake voice -> fields
          const fakeList = cfg.voices.list.map((v, i) => {
            const o = g.Object.create(SV);
            rApply(wmSet, fakes, [o, { voiceURI: v.name, name: v.name, lang: v.lang, localService: true, default: i === cfg.voices.defaultIndex }]);
            return o;
          });
          const isFake = (v) => rApply(wmHas, fakes, [v]);
          const localGet = rGOPD(SV, 'localService').get;
          for (const k of ['voiceURI', 'name', 'lang', 'localService', 'default']) {
            const d = rGOPD(SV, k);
            if (!d || typeof d.get !== 'function') continue;
            rDefine(SV, k, {
              ...d,
              get: wrap(d.get, (t, self, args) => {
                if (isFake(self)) return rApply(wmGet, fakes, [self])[k];
                const v = rApply(t, self, args);
                return k === 'default' && fakeList.length ? false : v;
              }),
            });
          }
          hookMethod(SS, 'getVoices', (t, self, args) => {
            const native = rApply(t, self, args);
            if (!native.length) return native; // not loaded yet: keep the real timing ("voiceschanged")
            const out = new g.Array();
            for (let i = 0; i < fakeList.length; i++) out[out.length] = fakeList[i];
            for (let i = 0; i < native.length; i++) if (!rApply(localGet, native[i], [])) out[out.length] = native[i];
            return out;
          });
          // utterance.voice = fakeVoice must not throw; the engine then uses its default voice
          const U = proto('SpeechSynthesisUtterance');
          const d = U && rGOPD(U, 'voice');
          if (d && d.get && d.set) {
            const chosen = new WeakMap();
            rDefine(U, 'voice', {
              ...d,
              get: wrap(d.get, (t, self, args) => {
                const v = rApply(t, self, args);
                return rApply(wmHas, chosen, [self]) ? rApply(wmGet, chosen, [self]) : v;
              }),
              set: wrap(d.set, (t, self, args) => {
                if (isFake(args[0])) {
                  rApply(t, self, [null]);
                  rApply(wmSet, chosen, [self, args[0]]);
                  return;
                }
                const r = rApply(t, self, args);
                rApply(wmDelete, chosen, [self]);
                return r;
              }),
            });
          }
        });
      }

      // ---------------------------------------------------------- WebRTC
      if (isWindow && cfg.webrtcDisabled) {
        safe(() => {
          delete g.RTCPeerConnection;
          delete g.webkitRTCPeerConnection;
          delete g.RTCDataChannel;
        });
      }

      // ---------------------------------------------------------- canvas
      const HC = proto('HTMLCanvasElement');
      const OCC = g.OffscreenCanvas;
      const OC = proto('OffscreenCanvas');
      const C2D = proto('CanvasRenderingContext2D');
      const OC2D = proto('OffscreenCanvasRenderingContext2D');
      const ID = proto('ImageData');
      if (cfg.canvas || cfg.webglImage) {
        safe(() => {
          const o = {
            hcGetContext: HC && HC.getContext,
            hcW: getterOf(HC, 'width'),
            hcH: getterOf(HC, 'height'),
            ocGetContext: OC && OC.getContext,
            ocW: getterOf(OC, 'width').get,
            ocH: getterOf(OC, 'height').get,
            createElement: g.Document && g.Document.prototype.createElement,
            ownerDocument: getterOf(proto('Node'), 'ownerDocument').get,
            c2d: C2D && { draw: C2D.drawImage, get: C2D.getImageData, put: C2D.putImageData },
            oc2d: OC2D && { draw: OC2D.drawImage, get: OC2D.getImageData, put: OC2D.putImageData },
            idData: getterOf(ID, 'data').get,
            idW: getterOf(ID, 'width').get,
            idH: getterOf(ID, 'height').get,
          };
          const wantNoise = (canvas) => {
            const t = rApply(wmGet, ctxTypes, [canvas]);
            if (!t) return false;
            return t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl' ? !!cfg.webglImage : !!cfg.canvas;
          };
          // Copies a canvas into a scratch 2D canvas and applies the pixel noise there.
          const noisyCopy = (canvas, offscreen) => {
            const w = rApply(offscreen ? o.ocW : o.hcW.get, canvas, []);
            const h = rApply(offscreen ? o.ocH : o.hcH.get, canvas, []);
            if (!w || !h || w * h > 16777216) return null;
            let tmp, ops;
            if (offscreen) {
              tmp = new OCC(w, h);
              ops = o.oc2d;
            } else {
              const doc = rApply(o.ownerDocument, canvas, []);
              tmp = rApply(o.createElement, doc, ['canvas']);
              rApply(o.hcW.set, tmp, [w]);
              rApply(o.hcH.set, tmp, [h]);
              ops = o.c2d;
            }
            const ctx = rApply(offscreen ? o.ocGetContext : o.hcGetContext, tmp, ['2d']);
            rApply(ops.draw, ctx, [canvas, 0, 0]);
            const img = rApply(ops.get, ctx, [0, 0, w, h]);
            noisePixels(rApply(o.idData, img, []), w, h, 0, 0);
            rApply(ops.put, ctx, [img, 0, 0]);
            return tmp;
          };
          const trackContext = (t, self, args) => {
            const ctx = rApply(t, self, args);
            if (ctx && !rApply(wmHas, ctxTypes, [self])) rApply(wmSet, ctxTypes, [self, '' + args[0]]);
            return ctx;
          };
          const exporter = (offscreen) => (t, self, args) => {
            let src = self;
            try {
              if (wantNoise(self)) src = noisyCopy(self, offscreen) || self;
            } catch (e) {}
            return rApply(t, src, args);
          };
          if (HC) {
            hookMethod(HC, 'getContext', trackContext);
            hookMethod(HC, 'toDataURL', exporter(false));
            hookMethod(HC, 'toBlob', exporter(false));
          }
          if (OC) {
            hookMethod(OC, 'getContext', trackContext);
            hookMethod(OC, 'convertToBlob', exporter(true));
          }
          if (cfg.canvas) {
            for (const P of [C2D, OC2D]) {
              hookMethod(P, 'getImageData', (t, self, args) => {
                const img = rApply(t, self, args);
                try {
                  noisePixels(rApply(o.idData, img, []), rApply(o.idW, img, []), rApply(o.idH, img, []), args[0] | 0, args[1] | 0);
                } catch (e) {}
                return img;
              });
            }
          }
        });
      }

      // ---------------------------------------------------------- WebGL / WebGPU
      for (const GL of [proto('WebGLRenderingContext'), proto('WebGL2RenderingContext')]) {
        if (!GL) continue;
        safe(() => {
          if (cfg.webgl) {
            hookMethod(GL, 'getParameter', (t, self, args) => {
              const v = rApply(t, self, args);
              if (typeof v === 'string') {
                if (args[0] === 0x9245) return cfg.webgl.vendor;
                if (args[0] === 0x9246) return cfg.webgl.renderer;
              }
              return v;
            });
          }
          if (cfg.webglImage) {
            hookMethod(GL, 'readPixels', (t, self, args) => {
              const r = rApply(t, self, args);
              try {
                const px = args[6];
                if (px && px.BYTES_PER_ELEMENT === 1 && args[4] === 0x1908) noisePixels(px, args[2] | 0, args[3] | 0, args[0] | 0, args[1] | 0);
              } catch (e) {}
              return r;
            });
          }
        });
      }
      if (cfg.webgl) {
        safe(() => {
          const P = proto('GPUAdapterInfo');
          hookGetter(P, 'vendor', () => cfg.webgl.gpuVendor);
          hookGetter(P, 'architecture', () => cfg.webgl.gpuArch);
          hookGetter(P, 'device', () => '');
          hookGetter(P, 'description', () => '');
        });
      }

      // ---------------------------------------------------------- audio
      if (cfg.audio) {
        safe(() => {
          const AB = proto('AudioBuffer');
          if (!AB) return;
          // Only rendered output is fingerprinted; buffers the page fills itself must read back exactly.
          const markRendered = (buf) => {
            try {
              if (buf) rApply(wsAdd, renderedAudio, [buf]);
            } catch (e) {}
            return buf;
          };
          hookMethod(proto('OfflineAudioContext'), 'startRendering', (t, self, args) => {
            const p = rApply(t, self, args);
            // registered before the page can call then(), so it runs first
            try {
              rApply(promiseThen, p, [markRendered, () => {}]);
            } catch (e) {}
            return p;
          });
          // the "complete" event fires before promise reactions run
          hookGetter(proto('OfflineAudioCompletionEvent'), 'renderedBuffer', markRendered);
          hookMethod(AB, 'getChannelData', (t, self, args) => {
            const data = rApply(t, self, args);
            if (rApply(wsHas, renderedAudio, [self]) && !rApply(wsHas, noisedAudio, [data])) {
              rApply(wsAdd, noisedAudio, [data]);
              try {
                noiseFloats(data, (args[0] | 0) + 1);
              } catch (e) {}
            }
            return data;
          });
          const getChannelData = AB.getChannelData;
          hookMethod(AB, 'copyFromChannel', (t, self, args) => {
            try {
              rApply(getChannelData, self, [args[1] | 0]);
            } catch (e) {}
            return rApply(t, self, args);
          });
          hookMethod(proto('AnalyserNode'), 'getFloatFrequencyData', (t, self, args) => {
            const r = rApply(t, self, args);
            try {
              noiseFloats(args[0], 0x3f);
            } catch (e) {}
            return r;
          });
        });
      }

      // ---------------------------------------------------------- ClientRects
      if (cfg.rects && isWindow) {
        safe(() => {
          const DR = proto('DOMRect');
          const p = ['x', 'y', 'width', 'height'].map((k) => rGOPD(DR, k));
          const tweak = (r) => {
            for (let i = 0; i < 4; i++) rApply(p[i].set, r, [fixRect(rApply(p[i].get, r, []), i + 1)]);
          };
          for (const P of [proto('Element'), proto('Range')]) {
            hookMethod(P, 'getBoundingClientRect', (t, self, args) => {
              const r = rApply(t, self, args);
              try {
                tweak(r);
              } catch (e) {}
              return r;
            });
            hookMethod(P, 'getClientRects', (t, self, args) => {
              const list = rApply(t, self, args);
              try {
                for (let i = 0, n = list.length; i < n; i++) tweak(list[i]);
              } catch (e) {}
              return list;
            });
          }
        });
      }

      // ---------------------------------------------------------- child frames
      if (isWindow) {
        safe(() => {
          const lengthGet = getterOf(g, 'length').get;
          const scan = () => {
            try {
              const n = lengthGet ? rApply(lengthGet, g, []) : g.length;
              for (let i = 0; i < n; i++) {
                try {
                  install(g[i]);
                } catch (e) {}
              }
            } catch (e) {}
          };
          const after = (t, self, args) => {
            const r = rApply(t, self, args);
            scan();
            return r;
          };
          for (const name of ['HTMLIFrameElement', 'HTMLFrameElement']) {
            const P = proto(name);
            hookGetter(P, 'contentWindow', (w) => {
              if (w) install(w);
              return w;
            });
            hookGetter(P, 'contentDocument', (d) => {
              if (d) scan();
              return d;
            });
          }
          const NodeP = proto('Node');
          for (const m of ['appendChild', 'insertBefore', 'replaceChild']) hookMethod(NodeP, m, after);
          const El = proto('Element');
          for (const m of ['append', 'prepend', 'after', 'before', 'replaceWith', 'replaceChildren', 'insertAdjacentElement', 'insertAdjacentHTML', 'setHTMLUnsafe']) {
            hookMethod(El, m, after);
          }
          hookSetter(El, 'innerHTML', scan);
          hookSetter(El, 'outerHTML', scan);
          hookSetter(proto('ShadowRoot'), 'innerHTML', scan);
          hookMethod(proto('Range'), 'insertNode', after);
          const DocP = proto('Document');
          hookMethod(DocP, 'write', after);
          hookMethod(DocP, 'writeln', after);
          hookMethod(g, 'open', (t, self, args) => {
            const w = rApply(t, self, args);
            if (w) install(w);
            return w;
          });
          // frames created by the HTML parser: the observer runs before the next parser-inserted script
          if (g.MutationObserver && g.document) new g.MutationObserver(scan).observe(g.document, { childList: true, subtree: true });
        });
      }
    };

    install(globalThis);
  } catch (e) {}
}

/** Source text to inject: `cfg` is embedded as JSON. */
export function buildScript(cfg) {
  return `(${spoof.toString()})(${JSON.stringify(cfg)});`;
}
