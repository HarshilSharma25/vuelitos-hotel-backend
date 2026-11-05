import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { getPrivateFileStorage } from '../files/private-storage.js';
import {
  assertUploadSize,
  detectMime,
  normalizeUpload,
} from '../files/upload-validation.js';

const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STAGED_PER_BOOKING = 6;

export function sha256File(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function uploaderKeyFor(user?: { id: string }, contactEmail?: string): string {
  if (user?.id) return `user:${user.id}`;
  return `guest:${contactEmail || 'unknown'}`;
}

export class StagedUploadService {
  async createStagedUpload(
    bookingId: string,
    uploaderKey: string,
    file: Express.Multer.File
  ) {
    const activeCount = await prisma.refundStagedUpload.count({
      where: {
        bookingId,
        uploaderKey,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (activeCount >= MAX_STAGED_PER_BOOKING) {
      throw new BadRequestError('Maximum staged uploads reached for this booking');
    }

    assertUploadSize(file.buffer);
    const mime = detectMime(file.buffer);
    if (!mime) throw new BadRequestError('Unsupported file type');
    const normalized = await normalizeUpload(file.buffer, mime);
    const contentHash = sha256File(normalized.data);
    const storage = getPrivateFileStorage();
    await storage.scanHook('', normalized.data);
    const ext =
      normalized.mime === 'application/pdf'
        ? '.pdf'
        : normalized.mime === 'image/png'
          ? '.png'
          : '.jpg';
    const storageKey = await storage.put(normalized.data, { ext });
    const expiresAt = new Date(Date.now() + STAGED_TTL_MS);

    const row = await prisma.refundStagedUpload.create({
      data: {
        bookingId,
        uploaderKey,
        storageKey,
        contentHash,
        originalName: file.originalname.slice(0, 255),
        mimeType: normalized.mime,
        sizeBytes: normalized.data.length,
        expiresAt,
      },
    });

    return {
      upload_id: row.id,
      name: row.originalName,
      size: row.sizeBytes,
      mime: row.mimeType,
      expires_at: row.expiresAt.toISOString(),
    };
  }

  async deleteStagedUpload(bookingId: string, uploaderKey: string, uploadId: string) {
    const row = await prisma.refundStagedUpload.findFirst({
      where: { id: uploadId, bookingId, uploaderKey, consumedAt: null },
    });
    if (!row) throw new NotFoundError('Staged upload not found');
    await getPrivateFileStorage().delete(row.storageKey).catch(() => undefined);
    await prisma.refundStagedUpload.delete({ where: { id: row.id } });
  }

  async consumeStagedUpload(bookingId: string, uploaderKey: string, uploadId: string) {
    const row = await prisma.refundStagedUpload.findFirst({
      where: { id: uploadId, bookingId, uploaderKey, consumedAt: null },
    });
    if (!row) throw new BadRequestError('Invalid or expired upload');
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestError('Upload expired');
    }
    await prisma.refundStagedUpload.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return row;
  }
}

export async function purgeExpiredStagedUploads(): Promise<number> {
  const now = new Date();
  const expired = await prisma.refundStagedUpload.findMany({
    where: { expiresAt: { lt: now }, consumedAt: null },
    take: 200,
  });
  const storage = getPrivateFileStorage();
  for (const row of expired) {
    await storage.delete(row.storageKey).catch(() => undefined);
    await prisma.refundStagedUpload.delete({ where: { id: row.id } });
  }
  await prisma.refundIdempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return expired.length;
}

export const stagedUploadService = new StagedUploadService();
