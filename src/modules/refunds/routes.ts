import { Router } from 'express';
import { authenticateUserOptional } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { refundUploadMiddleware } from '../../middleware/refund-upload.js';
import { refundService } from './service.js';
import { RefundReasonCode } from '@prisma/client';
import { BadRequestError } from '../../lib/errors.js';

export const refundRouter = Router({ mergeParams: true });

function parseKinds(body: Record<string, unknown>, fileCount: number): string[] {
  const raw = body.document_kinds ?? body.kinds;
  if (!raw) return Array(fileCount).fill('other');
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw.split(',').map((s) => s.trim());
    }
  }
  return Array(fileCount).fill('other');
}

refundRouter.post(
  '/refund-request',
  authenticateUserOptional,
  rateLimit({ bucket: 'refund-upload', max: 10, windowSec: 900 }),
  (req, res, next) => {
    refundUploadMiddleware(req, res, (err) => {
      if (err) next(err);
      else next();
    });
  },
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);
      const files = (req.files as Express.Multer.File[]) || [];
      const reasonCode = req.body.reason_code as RefundReasonCode;
      if (!reasonCode || !Object.values(RefundReasonCode).includes(reasonCode)) {
        throw new BadRequestError('Invalid reason_code');
      }
      let destinationDetails: Record<string, unknown> = {};
      if (req.body.destination_details) {
        destinationDetails =
          typeof req.body.destination_details === 'string'
            ? JSON.parse(req.body.destination_details)
            : req.body.destination_details;
      }
      const kinds = parseKinds(req.body, files.length);
      const data = await refundService.createRefundRequest(
        code,
        {
          reason_code: reasonCode,
          reason_text: req.body.reason_text,
          destination_method: String(req.body.destination_method || ''),
          destination_details: destinationDetails,
          files,
          document_kinds: kinds,
        } as any,
        token,
        req.user
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

refundRouter.get('/refund-request', authenticateUserOptional, async (req, res, next) => {
  try {
    const code = req.params.code as string;
    const token = (req.headers['x-booking-token'] as string) || (req.query.token as string);
    const data = await refundService.getRefundRequestForCustomer(code, token, req.user);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

refundRouter.post(
  '/refund-request/documents',
  authenticateUserOptional,
  rateLimit({ bucket: 'refund-upload', max: 10, windowSec: 900 }),
  (req, res, next) => {
    refundUploadMiddleware(req, res, (err) => {
      if (err) next(err);
      else next();
    });
  },
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);
      const files = (req.files as Express.Multer.File[]) || [];
      const kinds = parseKinds(req.body, files.length);
      const data = await refundService.addDocuments(code, files, kinds, token, req.user);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

refundRouter.get(
  '/refund-request/documents/:id',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const documentId = req.params.id as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);
      const { data, doc } = await refundService.downloadDocument(
        code,
        documentId,
        token,
        req.user
      );
      const safeName = doc.originalName.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 180);
      res.setHeader('Content-Type', doc.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(data);
    } catch (err) {
      next(err);
    }
  }
);
