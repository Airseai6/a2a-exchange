// Small shared utilities. No external dependencies.
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const newToken = (prefix = 'tok') => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Strip undefined recursively (JSON.stringify does not). */
export function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Atomic write: write to a temp file then rename. */
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Accept camelCase and snake_case aliases; return the first defined. */
export function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

export class HttpError extends Error {
  constructor(status, message, body = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export class RpcError extends Error {
  constructor(code, message, data = undefined, httpStatus = 200) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

export function log(level, message, extra = undefined) {
  const line = { time: nowIso(), level, message };
  if (extra !== undefined) line.extra = extra;
  process.stderr.write(JSON.stringify(line) + '\n');
}
