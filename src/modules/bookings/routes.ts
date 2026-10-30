import { Router } from 'express';
import { bookingService } from './service.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { sendData } from '../../middleware/response.js';
import {
  bookingCreatedResponseSchema,
  bookingCreateSchema,
  bookingPublicViewSchema,
  cancelBookingSchema,
  reportPaymentSchema,
} from './schemas.js';
import { NotFoundError } from '../../lib/errors.js';
import { authenticateUser, authenticateUserOptional } from '../../middleware/auth.js';

export const bookingRouter = Router();

// Honeypot fake creation
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

// Customer booking history (authenticated customers)
bookingRouter.get(
  '/bookings',
  authenticateUser,
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await bookingService.getCustomerBookings(req.user!.id);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.post(
  '/bookings',
  authenticateUserOptional,
  rateLimit({ bucket: 'booking-create', max: 5, windowSec: 600 }),
  validate({ body: bookingCreateSchema }),
  async (req, res, next) => {
    try {
      if (req.body.website && req.body.website.length > 0) {
        // Honeypot triggered: look successful, store nothing
        return sendData(res.status(201), bookingCreatedResponseSchema, fakeCreated());
      }

      const clientIp =
        (req.headers['cf-connecting-ip'] as string) ||
        (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
        req.ip;

      // Extract verified identity from JWT (never trust client body for userId)
      const userId = req.user?.id;

      const data = await bookingService.createBooking(req.body, { ip: clientIp, userId });
      sendData(res.status(201), bookingCreatedResponseSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

bookingRouter.get(
  '/bookings/:code',
  authenticateUserOptional,
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const code = req.params.code as string;
      const token =
        (req.headers['x-booking-token'] as string) ||
        (req.query.token as string);

      const data = await bookingService.getBookingView(code, token, req.user);
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
        (req.headers['x-booking-token'] as string) ||
        (req.query.token as string);

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
