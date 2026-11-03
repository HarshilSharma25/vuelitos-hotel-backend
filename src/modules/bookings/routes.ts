import { Router } from 'express';
import { bookingService } from './service.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { sendData } from '../../middleware/response.js';
import {
  bookingCreatedResponseSchema,
  bookingCreateSchema,
  bookingPublicViewSchema,
  bookingListResponseSchema,
  cancelBookingSchema,
  claimBookingSchema,
  reportPaymentSchema,
  stripeSessionResponseSchema,
} from './schemas.js';
import { authenticateUser, authenticateUserOptional } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { refundRouter } from '../refunds/routes.js';
import { preferredLocaleFromRequest } from '../../lib/display-locale.js';

export const bookingRouter = Router();

bookingRouter.use('/bookings', (req, res, next) => {
  if (req.path.endsWith('/status')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

function fakeCreated() {
  const year = new Date().getUTCFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return {
    code: `VH-${year}-${rand}`,
    access_token: 'fake-honeypot-token',
    status: 'requested' as const,
    sla_due_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
  };
}

bookingRouter.get('/bookings', authenticateUser, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const tab = typeof req.query.tab === 'string' ? req.query.tab : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === 'string' && limitRaw.trim()
        ? Number.parseInt(limitRaw, 10)
        : undefined;
    const data = await bookingService.getCustomerBookings(req.user!.id, {
      tab,
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
      displayLocale: preferredLocaleFromRequest(req),
    });
    sendData(res, bookingListResponseSchema, data);
  } catch (err) {
    next(err);
  }
});

bookingRouter.post(
  '/bookings',
  authenticateUserOptional,
  rateLimit({ bucket: 'booking-create', max: 5, windowSec: 600 }),
  validate({ body: bookingCreateSchema }),
  async (req, res, next) => {
    try {
      if (req.body.website && req.body.website.length > 0) {
        return sendData(res.status(201), bookingCreatedResponseSchema, fakeCreated());
      }

      const clientIp =
        (env.TRUST_CF_CONNECTING_IP ? (req.headers['cf-connecting-ip'] as string) : undefined) ||
        req.ip ||
        '127.0.0.1';

      const userId = req.user?.id;

      const data = await bookingService.createBooking(req.body, { ip: clientIp, userId });
      sendData(res.status(201), bookingCreatedResponseSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/claim',
  authenticateUser,
  validate({ body: claimBookingSchema }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const data = await bookingService.claimBooking(
        code,
        req.body.access_token,
        req.user!.id
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.get(
  '/bookings/:code/confirmation.pdf',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);
      const { buffer, filename } = await bookingService.streamConfirmationPdf(
        code,
        token,
        req.user
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.use('/bookings/:code', refundRouter);

bookingRouter.get(
  '/bookings/:code',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const data = await bookingService.getBookingView(
        code,
        token,
        req.user,
        preferredLocaleFromRequest(req)
      );
      sendData(res, bookingPublicViewSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/payments',
  authenticateUserOptional,
  validate({ body: reportPaymentSchema }),
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const data = await bookingService.reportPayment(code, req.body, token, req.user);
      sendData(res, bookingPublicViewSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/cancel',
  authenticateUserOptional,
  validate({ body: cancelBookingSchema }),
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const code = req.params.code as string;
      const token =
        req.body.token ||
        (req.headers['x-booking-token'] as string) ||
        (req.query.token as string);

      const data = await bookingService.cancelBooking(code, token, req.user);
      sendData(res, bookingPublicViewSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/payments/stripe-session',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const clientOrigin =
        (req.headers.origin as string) ||
        (req.headers.referer ? new URL(req.headers.referer as string).origin : undefined);
      const session = await bookingService.createStripePaymentSession(
        code,
        token,
        req.user,
        clientOrigin
      );
      sendData(res.status(200), stripeSessionResponseSchema, session);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/payments/stripe-session/refresh',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const result = await bookingService.refreshStripePaymentSession(code, token, req.user);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.get(
  '/bookings/:code/status',
  authenticateUserOptional,
  rateLimit({ bucket: 'booking-status', max: 120, windowSec: 60 }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) || (req.query.token as string);

      const { etag, data } = await bookingService.getBookingStatus(
        code,
        token,
        req.user,
        preferredLocaleFromRequest(req)
      );

      res.setHeader('ETag', etag);

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === etag.replace(/^W\//, ''))) {
        return res.status(304).end();
      }

      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings/:code/resend-access',
  rateLimit({ bucket: 'resend-access', max: 5, windowSec: 900 }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const email = req.body?.email;
      const result = await bookingService.resendAccessLink(code, email);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);
