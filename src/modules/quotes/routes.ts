import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, InvalidTransitionError } from '../../lib/errors.js';
import { sendData } from '../../middleware/response.js';
import { quotePublicViewSchema } from './schemas.js';

export const quoteRouter = Router();

quoteRouter.get('/quotes/share/:tokenKey', async (req, res, next) => {
  try {
    const { tokenKey } = req.params;
    const quote = await prisma.quote.findFirst({
      where: { tokenKey },
    });
    if (!quote) throw new NotFoundError('Quote not found');

    const isExpired = quote.expiresAt < new Date();
    const status =
      isExpired && quote.status !== 'accepted' && quote.status !== 'declined'
        ? 'expired'
        : quote.status;

    sendData(res, quotePublicViewSchema, {
      code: quote.code,
      status,
      lines: quote.lines as any[],
      expires_at: quote.expiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

quoteRouter.post('/quotes/share/:tokenKey/accept', async (req, res, next) => {
  try {
    const { tokenKey } = req.params;
    const quote = await prisma.quote.findFirst({
      where: { tokenKey },
    });
    if (!quote) throw new NotFoundError('Quote not found');

    if (
      quote.status === 'declined' ||
      quote.status === 'expired' ||
      quote.expiresAt < new Date()
    ) {
      throw new InvalidTransitionError('Cannot accept a declined or expired quote');
    }

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'accepted' },
    });

    sendData(res, quotePublicViewSchema, {
      code: updated.code,
      status: updated.status,
      lines: updated.lines as any[],
      expires_at: updated.expiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
