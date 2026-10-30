import crypto from 'node:crypto';
import { prisma } from './prisma.js';

export function generateAccessToken(): { token: string; accessKey: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(token).digest();
  const rawKey = digest.subarray(0, 16);
  // Format 16 bytes as standard UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const hex = rawKey.toString('hex');
  const accessKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return { token, accessKey };
}

export function hashTokenToAccessKey(token: string): string {
  const digest = crypto.createHash('sha256').update(token).digest();
  const rawKey = digest.subarray(0, 16);
  const hex = rawKey.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function verifyAccessToken(token: string, storedAccessKey: string): boolean {
  try {
    const derived = hashTokenToAccessKey(token);
    const bufA = Buffer.from(derived.replace(/-/g, ''), 'hex');
    const bufB = Buffer.from(storedAccessKey.replace(/-/g, ''), 'hex');
    if (bufA.length !== 16 || bufB.length !== 16) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export async function generateBookingCode(tx: any = prisma): Promise<string> {
  const currentYear = new Date().getUTCFullYear();
  const result: any = await tx.$queryRaw`SELECT nextval('booking_code_seq')::text as seq`;
  const seqNum = result[0]?.seq ?? '1';
  const padded = seqNum.padStart(6, '0');
  return `VH-${currentYear}-${padded}`;
}

export function generateQuoteCode(): string {
  const year = new Date().getUTCFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `VQ-${year}-${rand}`;
}
