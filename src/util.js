import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomId(len = 7) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let s = 'k';
  for (let i = 1; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export const randInt = (min, max) => min + crypto.randomInt(max - min + 1);
export const pick = (arr) => arr[crypto.randomInt(arr.length)];
export const randomSeed = () => crypto.randomInt(1, 0x7fffffff);

/** Writes a file atomically (tmp + rename), retrying briefly on Windows file locks. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `操作超时 (${ms}ms)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
