import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../lib/errors.js';

export function detectImageType(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
}).single('file');

export function imageUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  multerUpload(req, res, (err) => {
    if (err) return next(err);

    if (!req.file || !req.file.buffer) {
      return next(new ValidationError('Image file is required'));
    }

    const detected = detectImageType(req.file.buffer);
    if (!detected) {
      return next(
        new ValidationError('Invalid image format. Only JPEG, PNG, and WebP are allowed.')
      );
    }

    (req as any).detectedImageType = detected;
    next();
  });
}
