import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { handleStripeInternalEvent } from './internal.service.js';

export const internalPaymentsRouter = Router();

internalPaymentsRouter.post(
  '/payments/stripe-event',
  async (req: Request, res: Response): Promise<void> => {
    if (req.headers['x-forwarded-for']) {
      logger.warn('Direct access to internal endpoint rejected (X-Forwarded-For present)');
      res.status(403).json({ error: 'Direct access to internal endpoints is forbidden' });
      return;
    }

    if (req.headers.authorization || req.headers.cookie) {
      res.status(401).json({ error: 'Auth credentials not allowed on internal endpoints' });
      return;
    }

    const timestampHeader = req.headers['x-timestamp'];
    const signatureHeader = req.headers['x-signature'];

    if (!timestampHeader || !signatureHeader) {
      res.status(401).json({ error: 'Missing X-Timestamp or X-Signature header' });
      return;
    }

    const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
    const signatureStr = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    const tsNum = Number(timestampStr);
    const timestampMs = !isNaN(tsNum)
      ? (tsNum < 1e11 ? tsNum * 1000 : tsNum)
      : Date.parse(timestampStr);

    if (isNaN(timestampMs)) {
      res.status(401).json({ error: 'Invalid timestamp format' });
      return;
    }

    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;
    if (Math.abs(now - timestampMs) > fiveMinutesMs) {
      res.status(401).json({ error: 'Timestamp expired or out of allowed window' });
      return;
    }

    let rawBody = '';
    const anyReq = req as any;
    if (anyReq.rawBody) {
      rawBody = Buffer.isBuffer(anyReq.rawBody)
        ? anyReq.rawBody.toString('utf8')
        : String(anyReq.rawBody);
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else if (req.body && typeof req.body === 'object') {
      rawBody = JSON.stringify(req.body);
    }

    const computedSignature = crypto
      .createHmac('sha256', env.INTERNAL_SERVICE_SECRET)
      .update(`${timestampStr}.${rawBody}`)
      .digest('hex');

    const sigBuf = Buffer.from(signatureStr, 'utf8');
    const compBuf = Buffer.from(computedSignature, 'utf8');

    if (sigBuf.length !== compBuf.length || !crypto.timingSafeEqual(sigBuf, compBuf)) {
      res.status(401).json({ error: 'Invalid internal signature' });
      return;
    }

    try {
      const result = await handleStripeInternalEvent(req.body);
      res.status(200).json(result);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to process internal stripe event');
      res.status(500).json({ error: 'Internal processing error' });
    }
  }
);
