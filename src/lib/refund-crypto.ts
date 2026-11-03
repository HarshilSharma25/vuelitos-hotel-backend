import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function getKey(): Buffer {
  const raw = env.REFUND_DATA_KEY;
  if (!raw || raw.length < 32) {
    if (env.NODE_ENV === 'test') {
      return crypto.createHash('sha256').update('test-refund-data-key-32-bytes!!').digest();
    }
    throw new Error('REFUND_DATA_KEY must be at least 32 characters');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptRefundPayload(plain: object): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const json = JSON.stringify(plain);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptRefundPayload<T extends object>(blob: string): T {
  const [ivB64, tagB64, dataB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted refund payload');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(dec) as T;
}

export function maskDestinationForList(details: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(details)) {
    const s = String(v ?? '');
    if (s.length <= 4) {
      out[k] = '****';
    } else {
      out[k] = `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`;
    }
  }
  return out;
}
