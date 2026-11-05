import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export function generateAccessToken(): { token: string; accessKey: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(token).digest();
  const rawKey = digest.subarray(0, 16);
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

async function nextBookingSequence(db: Prisma.TransactionClient): Promise<string> {
  await db.$executeRaw`
    INSERT INTO booking_code_counters (id, seq)
    VALUES (1, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)
  `;
  const rows = await db.$queryRaw<Array<{ seq: bigint | number | string }>>`
    SELECT LAST_INSERT_ID() AS seq
  `;
  return String(rows[0]?.seq ?? '1');
}

export async function generateBookingCode(tx?: Prisma.TransactionClient): Promise<string> {
  const currentYear = new Date().getUTCFullYear();
  const seqNum = tx
    ? await nextBookingSequence(tx)
    : await prisma.$transaction((inner) => nextBookingSequence(inner));
  const padded = seqNum.padStart(6, '0');
  return `VH-${currentYear}-${padded}`;
}

export function generateQuoteCode(): string {
  const year = new Date().getUTCFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `VQ-${year}-${rand}`;
}
