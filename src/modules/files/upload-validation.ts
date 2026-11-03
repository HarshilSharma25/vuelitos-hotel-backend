import { getSharp } from '../../lib/sharp-lazy.js';

const MAX_BYTES = 5 * 1024 * 1024;

const SIGNATURES: { mime: string; check: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    mime: 'image/webp',
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  { mime: 'application/pdf', check: (b) => b.slice(0, 5).toString() === '%PDF-' },
];

function isHeic(b: Buffer): boolean {
  if (b.length < 12) return false;
  const brand = b.slice(4, 12).toString('ascii');
  return brand.includes('ftyp') && (brand.includes('heic') || brand.includes('heif') || brand.includes('mif1'));
}

export function detectMime(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (sig.check(buffer)) return sig.mime;
  }
  if (isHeic(buffer)) return 'image/heic';
  return null;
}

export async function normalizeUpload(buffer: Buffer, mime: string): Promise<{ data: Buffer; mime: string }> {
  if (mime === 'application/pdf') {
    return { data: buffer, mime };
  }
  if (mime.startsWith('image/')) {
    const sharp = await getSharp();
    if (!sharp) {
      const outMime = mime === 'image/heic' ? 'image/jpeg' : mime;
      return { data: buffer, mime: outMime };
    }
    const out = await sharp(buffer).rotate().withMetadata({ exif: undefined }).toBuffer();
    const outMime = mime === 'image/heic' ? 'image/jpeg' : mime;
    return { data: out, mime: outMime };
  }
  return { data: buffer, mime };
}

export function assertUploadSize(buffer: Buffer): void {
  if (buffer.length > MAX_BYTES) {
    throw new Error('FILE_TOO_LARGE');
  }
}

export const ALLOWED_UPLOAD_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;
