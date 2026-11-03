import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { ActorType, normalizeEventName, transition, getAllowedActions, getAdminAllowedActions } from '../bookings/state-machine.js';
import type { PaymentMethod } from '../pricing/types.js';
import { ratesService } from '../rates/service.js';
import { bookingService } from '../bookings/service.js';
import { settingsService } from '../settings/service.js';
import { adminAuthRouter } from './auth.js';
import { fileStorage } from '../files/storage.js';
import { generateQuoteCode } from '../../lib/ids.js';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { imageUploadMiddleware } from '../../middleware/upload.js';
import { tarifarioService } from '../tarifario/service.js';
import { env } from '../../config/env.js';
import { recordBookingTransition } from '../../lib/metrics.js';
import { BookingStatus, Role } from '@prisma/client';
import { adminRefundService } from '../refunds/admin-service.js';
import { refundUploadMiddleware } from '../../middleware/refund-upload.js';
import { notifyBookingStatusChange } from '../notifications/booking-events.js';

function refundActor(user: { id: string; role: string }) {
  return { id: user.id, role: user.role as Role };
}

export const adminRouter = Router();

adminRouter.use(adminAuthRouter);


adminRouter.get('/bookings/inbox', requireRole('agent'), async (req, res, next) => {
  try {
    const { status, hotelId, paymentMode, overdue, search, q, page = '1', limit = '20' } = req.query as any;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * take;

    const where: any = {};
    if (status && status !== 'all') {
      where.status = status;
    }
    if (paymentMode) {
      where.paymentMode = paymentMode;
    }
    if (hotelId) {
      where.items = { some: { hotelId } };
    }
    const queryTerm = search || q;
    if (queryTerm) {
      where.OR = [
        { code: { contains: queryTerm, mode: 'insensitive' } },
        { contactName: { contains: queryTerm, mode: 'insensitive' } },
        { contactEmail: { contains: queryTerm, mode: 'insensitive' } },
      ];
    }
    if (overdue === 'true') {
      where.slaDueAt = { lt: new Date() };
      where.status = { in: ['requested', 'checking_availability', 'awaiting_payment'] };
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: [
          { slaDueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip,
        take,
        include: {
          items: true,
          payments: { orderBy: { submittedAt: 'desc' }, take: 1 },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    const allWhere = hotelId ? { items: { some: { hotelId } } } : {};
    const [
      countAll,
      countRequested,
      countChecking,
      countAwaitingPayment,
      countPaymentSubmitted,
      countPaymentVerified,
      countConfirmed,
      countOverdue,
    ] = await Promise.all([
      prisma.booking.count({ where: allWhere }),
      prisma.booking.count({ where: { ...allWhere, status: 'requested' } }),
      prisma.booking.count({ where: { ...allWhere, status: 'checking_availability' } }),
      prisma.booking.count({ where: { ...allWhere, status: 'awaiting_payment' } }),
      prisma.booking.count({ where: { ...allWhere, status: 'payment_submitted' } }),
      prisma.booking.count({ where: { ...allWhere, status: 'payment_verified' } }),
      prisma.booking.count({ where: { ...allWhere, status: 'confirmed' } }),
      prisma.booking.count({
        where: {
          ...allWhere,
          slaDueAt: { lt: new Date() },
          status: { in: ['requested', 'checking_availability', 'awaiting_payment'] },
        },
      }),
    ]);

    const now = Date.now();
    const hotelIds = [...new Set(bookings.flatMap((b) => b.items.map((i) => i.hotelId)))];
    const hotels = await prisma.hotel.findMany({
      where: { id: { in: hotelIds } },
      select: { id: true, slug: true, name: true, destination: true },
    });
    const hotelMap = new Map(hotels.map((h) => [h.id, h]));

    const items = bookings.map((b) => {
      const msLeft = b.slaDueAt ? b.slaDueAt.getTime() - now : null;
      const isOverdue = msLeft !== null ? msLeft < 0 : false;
      const primaryItem = b.items[0];
      const hotel = primaryItem ? hotelMap.get(primaryItem.hotelId) : null;

      const allowedActions = getAdminAllowedActions(
        b.status,
        b.paymentMode as any,
        primaryItem?.checkIn
      );

      return {
        id: b.id,
        code: b.code,
        status: b.status,
        payment_mode: b.paymentMode,
        paymentMode: b.paymentMode,
        contact_name: b.contactName,
        contactEmail: b.contactEmail,
        contact_phone: b.contactPhone,
        notes: b.notes,
        guest_details: (b as any).guestDetails,
        guestDetails: (b as any).guestDetails,
        hotel: hotel
          ? { id: hotel.id, slug: hotel.slug, name: hotel.name, destination: hotel.destination }
          : null,
        created_at: b.createdAt.toISOString(),
        sla_due_at: b.slaDueAt ? b.slaDueAt.toISOString() : null,
        slaDueAt: b.slaDueAt ? b.slaDueAt.toISOString() : null,
        sla_minutes_remaining: msLeft !== null ? Math.round(msLeft / 60000) : null,
        is_overdue: isOverdue,
        isOverdue,
        allowed_actions: allowedActions,
        allowedActions,
        payments: b.payments,
      };
    });

    res.json({
      data: items,
      meta: {
        total,
        page: pageNum,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
      status_counts: {
        all: countAll,
        requested: countRequested,
        checking_availability: countChecking,
        awaiting_payment: countAwaitingPayment,
        payment_submitted: countPaymentSubmitted,
        payment_verified: countPaymentVerified,
        confirmed: countConfirmed,
        overdue: countOverdue,
      },
      statusCounts: {
        all: countAll,
        requested: countRequested,
        checking_availability: countChecking,
        awaiting_payment: countAwaitingPayment,
        payment_submitted: countPaymentSubmitted,
        payment_verified: countPaymentVerified,
        confirmed: countConfirmed,
        overdue: countOverdue,
      },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/bookings', requireRole('agent'), async (req, res, next) => {
  try {
    const { status, overdue, q, cursor } = req.query as any;

    const where: any = {};
    if (status) {
      where.status = status;
    }
    if (q) {
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { contactEmail: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (overdue === 'true') {
      where.slaDueAt = { lt: new Date() };
      where.status = { in: ['requested', 'checking_availability'] };
    }

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { slaDueAt: 'asc' },
      take: 50,
      include: {
        items: true,
      },
    });

    const now = Date.now();
    const items = bookings.map((b) => {
      const msLeft = b.slaDueAt ? b.slaDueAt.getTime() - now : null;
      return {
        id: b.id,
        code: b.code,
        status: b.status,
        contact_name: b.contactName,
        contact_email: b.contactEmail,
        contact_phone: b.contactPhone,
        created_at: b.createdAt.toISOString(),
        sla_due_at: b.slaDueAt ? b.slaDueAt.toISOString() : null,
        sla_minutes_remaining: msLeft !== null ? Math.round(msLeft / 60000) : null,
        is_overdue: msLeft !== null ? msLeft < 0 : false,
      };
    });

    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/bookings/:code', requireRole('agent'), async (req, res, next) => {
  try {
    const code = req.params.code as string;
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: {
        items: true,
        events: { orderBy: { createdAt: 'desc' } },
        payments: { orderBy: { submittedAt: 'desc' } },
        checks: true,
      },
    });

    if (!booking) {
      throw new NotFoundError(`Booking '${req.params.code}' not found`);
    }

    const hotelIds = [...new Set(booking.items.map((i) => i.hotelId))];
    const hotels = await prisma.hotel.findMany({
      where: { id: { in: hotelIds } },
      select: { id: true, slug: true, name: true, destination: true },
    });
    const hotelMap = new Map(hotels.map((h) => [h.id, h]));

    const enrichedItems = booking.items.map((item) => {
      const h = hotelMap.get(item.hotelId);
      return {
        ...item,
        hotelSlug: h?.slug || '',
        hotel_slug: h?.slug || '',
        hotelName: h?.name || '',
        hotel_name: h?.name || '',
        hotel: h || null,
      };
    });

    const firstItem = booking.items[0];
    const allowedActions = getAdminAllowedActions(
      booking.status,
      booking.paymentMode as any,
      firstItem?.checkIn
    );

    res.json({
      data: {
        ...booking,
        guest_details: (booking as any).guestDetails,
        guestDetails: (booking as any).guestDetails,
        items: enrichedItems,
        allowed_actions: allowedActions,
        allowedActions,
      },
    });
  } catch (err) {
    next(err);
  }
});

const transitionSchema = z.object({
  event: z.enum([
    'start_availability_check',
    'confirm_availability',
    'confirm_pay_at_hotel',
    'offer_alternatives',
    'choose_alternative',
    'decline_alternatives',
    'mark_unavailable',
    'submit_payment',
    'verify_payment',
    'reject_payment',
    'confirm_booking',
    'expire_payment_window',
    'cancel',
    'complete_refund',
    'approve',
    'start_check',
    'hotel_confirmed',
    'accept_alternative',
  ]),
  note: z.string().max(1000).optional(),
});

adminRouter.post(
  '/bookings/:code/transition',
  requireRole('agent'),
  validate({ body: transitionSchema }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const booking = await prisma.booking.findUnique({
        where: { code },
        include: { items: true },
      });

      if (!booking) {
        throw new NotFoundError(`Booking '${code}' not found`);
      }

      if (req.body.event === 'approve') {
        const approved = await bookingService.approveBooking(code, req.user!, req.body.note);
        return res.json({ data: approved });
      }

      const canonicalEvent = normalizeEventName(req.body.event);
      if (canonicalEvent === 'complete_refund' && req.user!.role === 'agent') {
        throw new ForbiddenError('Admin role required for refund completion');
      }

      const actorType = req.user!.role as ActorType;
      const nextStep = transition({
        currentStatus: booking.status,
        event: req.body.event,
        actorType,
        actorId: req.user!.id,
        note: req.body.note,
        paymentMode: booking.paymentMode as any,
      });

      let newSlaDueAt: Date | null | undefined = undefined;
      let newPaymentWindowHours: number | undefined = undefined;

      if (nextStep.event === 'confirm_availability') {
        const hotelId = booking.items[0]?.hotelId;
        const effective = await settingsService.getEffectiveCheckoutSettings(hotelId);
        const windowHours = booking.paymentWindowHours ?? effective.paymentWindowHours;
        newSlaDueAt = new Date(Date.now() + windowHours * 3600 * 1000);
        newPaymentWindowHours = windowHours;
      } else if (
        nextStep.event === 'confirm_pay_at_hotel' ||
        nextStep.toStatus === BookingStatus.confirmed ||
        nextStep.toStatus === BookingStatus.refund_pending ||
        nextStep.toStatus === BookingStatus.unavailable ||
        nextStep.toStatus === BookingStatus.cancelled ||
        nextStep.toStatus === BookingStatus.refunded
      ) {
        newSlaDueAt = null;
      }

      await prisma.$transaction(async (tx) => {
        const updateData: any = { status: nextStep.toStatus };
        if (newSlaDueAt !== undefined) updateData.slaDueAt = newSlaDueAt;
        if (newPaymentWindowHours !== undefined) updateData.paymentWindowHours = newPaymentWindowHours;

        const updateResult = await tx.booking.updateMany({
          where: { id: booking.id, status: nextStep.fromStatus },
          data: updateData,
        });

        if (updateResult.count === 0) {
          throw new InvalidTransitionError('State transition conflict');
        }

        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: nextStep.event,
            fromStatus: nextStep.fromStatus,
            toStatus: nextStep.toStatus,
            actorType: nextStep.actorType,
            actorId: req.user!.id,
            note: nextStep.note || null,
          },
        });
      });

      recordBookingTransition(nextStep.event);

      await ratesService.bumpCatalogCache();
      await notifyBookingStatusChange(booking.code, nextStep.toStatus);

      const updated = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: { events: { orderBy: { createdAt: 'desc' } } },
      });

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post('/bookings/:code/approve', requireRole('agent'), async (req, res, next) => {
  try {
    const code = req.params.code as string;
    const updated = await bookingService.approveBooking(code, req.user!, req.body?.note);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  '/bookings/bulk-transition',
  requireRole('agent'),
  validate({
    body: z.object({
      codes: z.array(z.string()).min(1).max(50),
      event: z.string(),
      note: z.string().max(1000).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { codes, event, note } = req.body;
      const results: { code: string; success: boolean; error?: string; toStatus?: string }[] = [];

      for (const code of codes) {
        try {
          if (event === 'approve') {
            const updated = await bookingService.approveBooking(code, req.user!, note);
            results.push({ code, success: true, toStatus: updated.status });
          } else {
            const booking = await prisma.booking.findUnique({ where: { code }, include: { items: true } });
            if (!booking) {
              results.push({ code, success: false, error: 'Booking not found' });
              continue;
            }
            const actorType = req.user!.role as ActorType;
            const nextStep = transition({
              currentStatus: booking.status,
              event,
              actorType,
              actorId: req.user!.id,
              note,
              paymentMode: booking.paymentMode as any,
            });

            let newSlaDueAt: Date | null | undefined = undefined;
            if (nextStep.event === 'confirm_availability') {
              const hotelId = booking.items[0]?.hotelId;
              const effective = await settingsService.getEffectiveCheckoutSettings(hotelId);
              newSlaDueAt = new Date(Date.now() + (booking.paymentWindowHours ?? effective.paymentWindowHours) * 3600 * 1000);
            } else if (nextStep.event === 'confirm_pay_at_hotel') {
              newSlaDueAt = null;
            }

            await prisma.$transaction(async (tx) => {
              const updateData: any = { status: nextStep.toStatus };
              if (newSlaDueAt !== undefined) updateData.slaDueAt = newSlaDueAt;

              await tx.booking.update({
                where: { id: booking.id },
                data: updateData,
              });

              await tx.bookingEvent.create({
                data: {
                  bookingId: booking.id,
                  event: nextStep.event,
                  fromStatus: nextStep.fromStatus,
                  toStatus: nextStep.toStatus,
                  actorType: nextStep.actorType,
                  actorId: req.user!.id,
                  note: nextStep.note || null,
                },
              });
            });
            recordBookingTransition(nextStep.event);
            results.push({ code, success: true, toStatus: nextStep.toStatus });
          }
        } catch (err: any) {
          results.push({ code, success: false, error: err.message });
        }
      }

      await ratesService.bumpCatalogCache();
      res.json({ data: { results } });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/bookings/:code/extend-payment-window',
  requireRole('agent'),
  validate({
    body: z.object({
      additionalHours: z.number().int().positive().max(168),
      note: z.string().trim().min(1).max(1000),
    }),
  }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const { additionalHours, note } = req.body;
      const updated = await bookingService.extendPaymentWindow(code, additionalHours, note, req.user!);
      res.json({
        data: {
          ...updated,
          payment_window_hours: updated.paymentWindowHours,
          reminders_sent: updated.remindersSent,
          sla_due_at: updated.slaDueAt ? updated.slaDueAt.toISOString() : null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/bookings/:code/verify-payment',
  requireRole('agent'),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const updated = await bookingService.verifyPayment(code, req.body || {}, req.user!);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/bookings/:code/reject-payment',
  requireRole('agent'),
  validate({
    body: z.object({
      paymentId: z.string().optional(),
      reason: z.string().min(1).max(200),
      notes: z.string().max(1000).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const updated = await bookingService.rejectPayment(code, req.body, req.user!);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get(
  '/bookings/:code/check-duplicate-reference',
  requireRole('agent'),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const booking = await prisma.booking.findUnique({ where: { code } });
      if (!booking) throw new NotFoundError(`Booking '${code}' not found`);

      const method = req.query.method as PaymentMethod;
      const reference = (req.query.reference as string) || '';

      const check = await bookingService.checkDuplicateReference(method, reference, booking.id);
      res.json({ data: check });
    } catch (err) {
      next(err);
    }
  }
);


const availabilityCheckSchema = z
  .object({
    booking_id: z.string().optional(),
    bookingId: z.string().optional(),
    hotel_id: z.string().optional(),
    hotelId: z.string().optional(),
    check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(['pending', 'available', 'unavailable', 'on_request']),
    note: z.string().max(1000).optional(),
  })
  .refine((d) => d.hotel_id || d.hotelId, {
    message: 'hotel_id or hotelId is required',
    path: ['hotel_id'],
  })
  .refine((d) => (d.check_in || d.checkIn) && (d.check_out || d.checkOut), {
    message: 'check_in and check_out are required',
    path: ['check_in'],
  });

adminRouter.post(
  '/availability',
  requireRole('agent'),
  validate({ body: availabilityCheckSchema }),
  async (req, res, next) => {
    try {
      const rawIn = req.body.checkIn ?? req.body.check_in;
      const rawOut = req.body.checkOut ?? req.body.check_out;
      const dIn = new Date(`${rawIn}T00:00:00Z`);
      const dOut = new Date(`${rawOut}T00:00:00Z`);

      if (dOut <= dIn) {
        throw new ValidationError('check_out must be after check_in');
      }

      const hotelId = (req.body.hotelId ?? req.body.hotel_id) as string;
      const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
      if (!hotel) throw new NotFoundError('Hotel not found');

      const checkedAt = req.body.status !== 'pending' ? new Date() : null;

      const check = await prisma.availabilityCheck.create({
        data: {
          bookingId: (req.body.bookingId ?? req.body.booking_id) || null,
          hotelId,
          checkIn: dIn,
          checkOut: dOut,
          status: req.body.status,
          checkedBy: req.user!.id,
          checkedAt,
          note: req.body.note || null,
        },
      });

      await ratesService.bumpCatalogCache();
      res.status(201).json({ data: check });
    } catch (err) {
      next(err);
    }
  }
);


function normalizeHotelInput(body: any) {
  if (!body || typeof body !== 'object') return {};
  const data: Record<string, any> = {};

  if (body.name !== undefined) data.name = String(body.name).trim();
  if (body.slug !== undefined) data.slug = String(body.slug).trim();
  if (body.destination !== undefined) data.destination = String(body.destination).trim();
  if (body.category !== undefined) data.category = String(body.category).trim();

  if (body.starRating !== undefined || body.star_rating !== undefined) {
    const raw = body.starRating !== undefined ? body.starRating : body.star_rating;
    if (raw === null || raw === '' || raw === undefined) {
      data.starRating = null;
    } else {
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 1 || num > 5) {
        throw new ValidationError('star_rating must be an integer between 1 and 5');
      }
      data.starRating = Math.round(num);
    }
  }

  if (body.baseCurrency !== undefined || body.base_currency !== undefined) {
    const val = body.baseCurrency ?? body.base_currency;
    if (val !== undefined && val !== null) {
      if (val !== 'USD' && val !== 'EUR') {
        throw new ValidationError('base_currency must be USD or EUR');
      }
      data.baseCurrency = val;
    }
  }

  if (body.isSoloDivisas !== undefined || body.is_solo_divisas !== undefined) {
    const raw = body.isSoloDivisas !== undefined ? body.isSoloDivisas : body.is_solo_divisas;
    data.isSoloDivisas = typeof raw === 'string' ? raw === 'true' : Boolean(raw);
  }

  if (body.defaultCommissionPercent !== undefined || body.default_commission_percent !== undefined) {
    const raw = body.defaultCommissionPercent !== undefined ? body.defaultCommissionPercent : body.default_commission_percent;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      throw new ValidationError('default_commission_percent must be a number between 0 and 100');
    }
    data.defaultCommissionPercent = num;
  }

  if (body.availabilityMode !== undefined || body.availability_mode !== undefined) {
    const val = body.availabilityMode ?? body.availability_mode;
    if (val !== undefined && val !== null) {
      if (val !== 'manual' && val !== 'api') {
        throw new ValidationError('availability_mode must be manual or api');
      }
      data.availabilityMode = val;
    }
  }

  if (body.isActive !== undefined || body.is_active !== undefined) {
    const raw = body.isActive !== undefined ? body.isActive : body.is_active;
    data.isActive = typeof raw === 'string' ? raw === 'true' : Boolean(raw);
  }

  if (body.description !== undefined) {
    data.description = body.description || null;
  }

  if (body.coverImageKey !== undefined || body.cover_image_key !== undefined) {
    data.coverImageKey = (body.coverImageKey ?? body.cover_image_key) || null;
  }

  if (body.coverImageUrl !== undefined || body.cover_image_url !== undefined) {
    data.coverImageUrl = (body.coverImageUrl ?? body.cover_image_url) || null;
  }

  if (data.coverImageKey && !data.coverImageUrl) {
    data.coverImageUrl = data.coverImageKey.startsWith('http://') || data.coverImageKey.startsWith('https://')
      ? data.coverImageKey
      : `${env.FILES_PUBLIC_BASE_URL}/${data.coverImageKey.replace(/^private\//, 'public/')}`;
  }

  return data;
}

function formatHotelResponse(hotel: any) {
  if (!hotel) return hotel;
  let coverImageUrl = hotel.coverImageUrl;
  let coverImageKey = hotel.coverImageKey;

  const images = Array.isArray(hotel.images)
    ? hotel.images.map((img: any) => ({
        ...img,
        url: img.url || `${env.FILES_PUBLIC_BASE_URL}/${img.key.replace(/^private\//, 'public/')}`,
        sort_order: img.sortOrder ?? img.sort_order ?? 0,
        sortOrder: img.sortOrder ?? img.sort_order ?? 0,
      }))
    : hotel.images;

  if (!coverImageUrl && coverImageKey) {
    coverImageUrl = coverImageKey.startsWith('http://') || coverImageKey.startsWith('https://')
      ? coverImageKey
      : `${env.FILES_PUBLIC_BASE_URL}/${coverImageKey.replace(/^private\//, 'public/')}`;
  } else if (!coverImageUrl && images && images.length > 0) {
    const sorted = [...images].sort((a: any, b: any) => {
      const aPub = a.status === 'published';
      const bPub = b.status === 'published';
      if (aPub && !bPub) return -1;
      if (!aPub && bPub) return 1;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
    const first = sorted[0];
    if (first) {
      coverImageKey = coverImageKey || first.key;
      coverImageUrl = first.url || `${env.FILES_PUBLIC_BASE_URL}/${first.key.replace(/^private\//, 'public/')}`;
    }
  }

  return {
    ...hotel,
    images,
    coverImageKey: coverImageKey ?? null,
    coverImageUrl: coverImageUrl ?? null,
    cover_image_key: coverImageKey ?? null,
    cover_image_url: coverImageUrl ?? null,
    starRating: hotel.starRating ?? null,
    star_rating: hotel.starRating ?? null,
    baseCurrency: hotel.baseCurrency,
    base_currency: hotel.baseCurrency,
    isSoloDivisas: Boolean(hotel.isSoloDivisas),
    is_solo_divisas: Boolean(hotel.isSoloDivisas),
    defaultCommissionPercent: hotel.defaultCommissionPercent !== undefined ? Number(hotel.defaultCommissionPercent) : 10,
    default_commission_percent: hotel.defaultCommissionPercent !== undefined ? Number(hotel.defaultCommissionPercent) : 10,
    availabilityMode: hotel.availabilityMode,
    availability_mode: hotel.availabilityMode,
    isActive: Boolean(hotel.isActive),
    is_active: Boolean(hotel.isActive),
  };
}

adminRouter.get('/hotels', requireRole('admin'), async (_req, res, next) => {
  try {
    const hotels = await prisma.hotel.findMany({
      include: {
        rooms: true,
        seasons: { include: { rates: true } },
        paymentRules: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ data: hotels.map(formatHotelResponse) });
  } catch (err) {
    next(err);
  }
});

const hotelCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
  destination: z.string().min(2),
  category: z.string().min(2),
  star_rating: z.coerce.number().int().min(1).max(5).optional(),
  starRating: z.coerce.number().int().min(1).max(5).optional(),
  base_currency: z.enum(['USD', 'EUR']).optional(),
  baseCurrency: z.enum(['USD', 'EUR']).optional(),
  is_solo_divisas: z.boolean().optional(),
  isSoloDivisas: z.boolean().optional(),
  default_commission_percent: z.coerce.number().optional(),
  defaultCommissionPercent: z.coerce.number().optional(),
  availability_mode: z.enum(['manual', 'api']).optional(),
  availabilityMode: z.enum(['manual', 'api']).optional(),
  is_active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional().nullable(),
  cover_image_key: z.string().optional().nullable(),
  coverImageKey: z.string().optional().nullable(),
  cover_image_url: z.string().optional().nullable(),
  coverImageUrl: z.string().optional().nullable(),
}).refine((data) => data.base_currency || data.baseCurrency, {
  message: 'base_currency or baseCurrency is required',
  path: ['base_currency'],
});

adminRouter.post(
  '/hotels',
  requireRole('admin'),
  validate({ body: hotelCreateSchema }),
  async (req, res, next) => {
    try {
      const data = normalizeHotelInput(req.body);
      const hotel = await prisma.hotel.create({
        data: {
          name: data.name,
          slug: data.slug,
          destination: data.destination,
          category: data.category,
          starRating: data.starRating ?? null,
          baseCurrency: data.baseCurrency,
          isSoloDivisas: data.isSoloDivisas ?? false,
          defaultCommissionPercent: data.defaultCommissionPercent ?? 10.0,
          availabilityMode: data.availabilityMode ?? 'manual',
          isActive: data.isActive ?? true,
          description: data.description ?? null,
          coverImageKey: data.coverImageKey ?? null,
          coverImageUrl: data.coverImageUrl ?? null,
        },
        include: {
          rooms: true,
          seasons: { include: { rates: true } },
          paymentRules: true,
          images: { orderBy: { sortOrder: 'asc' } },
        },
      });

      await ratesService.bumpCatalogCache();
      res.status(201).json({ data: formatHotelResponse(hotel) });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get('/hotels/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      include: {
        rooms: true,
        seasons: { include: { rates: true } },
        paymentRules: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!hotel) throw new NotFoundError('Hotel not found');
    res.json({ data: formatHotelResponse(hotel) });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/hotels/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.hotel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Hotel not found');

    const data = normalizeHotelInput(req.body);
    const hotel = await prisma.hotel.update({
      where: { id },
      data,
      include: {
        rooms: true,
        seasons: { include: { rates: true } },
        paymentRules: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: formatHotelResponse(hotel) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/hotels/:id/rooms', requireRole('admin'), async (req, res, next) => {
  try {
    const rooms = await prisma.roomType.findMany({ where: { hotelId: req.params.id as string } });
    res.json({ data: rooms });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/hotels/:id/rooms', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.hotel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Hotel not found');

    const maxOccupancy = Number(req.body.maxOccupancy ?? req.body.max_occupancy);
    const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : (req.body.is_active !== undefined ? Boolean(req.body.is_active) : true);
    const room = await prisma.roomType.create({
      data: {
        hotelId: id,
        name: req.body.name,
        maxOccupancy: Number.isFinite(maxOccupancy) && maxOccupancy > 0 ? maxOccupancy : 2,
        isActive,
      },
    });
    await ratesService.bumpCatalogCache();
    res.status(201).json({ data: room });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/hotels/:id/rooms/:roomId', requireRole('admin'), async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const existing = await prisma.roomType.findUnique({ where: { id: roomId } });
    if (!existing) throw new NotFoundError('Room not found');

    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.maxOccupancy !== undefined || req.body.max_occupancy !== undefined) {
      const occ = Number(req.body.maxOccupancy ?? req.body.max_occupancy);
      if (Number.isFinite(occ) && occ > 0) {
        data.maxOccupancy = Math.round(occ);
      }
    }
    if (req.body.isActive !== undefined || req.body.is_active !== undefined) {
      data.isActive = Boolean(req.body.isActive ?? req.body.is_active);
    }
    const room = await prisma.roomType.update({
      where: { id: roomId },
      data,
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: room });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/hotels/:id/seasons', requireRole('admin'), async (req, res, next) => {
  try {
    const seasons = await prisma.season.findMany({
      where: { hotelId: req.params.id as string },
      include: { rates: true },
    });
    res.json({ data: seasons });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/hotels/:id/seasons', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.hotel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Hotel not found');

    const dateFrom = req.body.dateFrom ?? req.body.date_from;
    const dateTo = req.body.dateTo ?? req.body.date_to;
    const bookingFrom = req.body.bookingFrom ?? req.body.booking_from;
    const bookingTo = req.body.bookingTo ?? req.body.booking_to;
    const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : (req.body.is_active !== undefined ? Boolean(req.body.is_active) : true);

    const season = await prisma.season.create({
      data: {
        hotelId: id,
        name: req.body.name,
        priority: Number(req.body.priority) || 1,
        dateFrom: new Date(`${dateFrom}T00:00:00Z`),
        dateTo: new Date(`${dateTo}T00:00:00Z`),
        bookingFrom: bookingFrom ? new Date(`${bookingFrom}T00:00:00Z`) : null,
        bookingTo: bookingTo ? new Date(`${bookingTo}T00:00:00Z`) : null,
        isActive,
      },
    });
    await ratesService.bumpCatalogCache();
    res.status(201).json({ data: season });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/hotels/:id/seasons/:seasonId', requireRole('admin'), async (req, res, next) => {
  try {
    const seasonId = req.params.seasonId as string;
    const existing = await prisma.season.findUnique({ where: { id: seasonId } });
    if (!existing) throw new NotFoundError('Season not found');

    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.priority !== undefined) data.priority = Number(req.body.priority);
    const dateFrom = req.body.dateFrom ?? req.body.date_from;
    if (dateFrom) data.dateFrom = new Date(`${dateFrom}T00:00:00Z`);
    const dateTo = req.body.dateTo ?? req.body.date_to;
    if (dateTo) data.dateTo = new Date(`${dateTo}T00:00:00Z`);
    const bookingFrom = req.body.bookingFrom ?? req.body.booking_from;
    if (bookingFrom !== undefined) {
      data.bookingFrom = bookingFrom ? new Date(`${bookingFrom}T00:00:00Z`) : null;
    }
    const bookingTo = req.body.bookingTo ?? req.body.booking_to;
    if (bookingTo !== undefined) {
      data.bookingTo = bookingTo ? new Date(`${bookingTo}T00:00:00Z`) : null;
    }
    const isActive = req.body.isActive ?? req.body.is_active;
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const season = await prisma.season.update({
      where: { id: seasonId },
      data,
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: season });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/hotels/:id/rates', requireRole('admin'), async (req, res, next) => {
  try {
    const rates = await prisma.rate.findMany({
      where: { season: { hotelId: req.params.id as string } },
    });
    res.json({ data: rates });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/hotels/:id/rates', requireRole('admin'), async (req, res, next) => {
  try {
    const body = req.body;
    const markupRaw = body.markupPercent !== undefined ? body.markupPercent : body.markup_percent;
    const sellRateRaw = body.sellRate !== undefined ? body.sellRate : body.sell_rate;
    const percentAdultRaw = body.percentOfAdult !== undefined ? body.percentOfAdult : body.percent_of_adult;

    const rate = await prisma.rate.create({
      data: {
        roomTypeId: body.roomTypeId ?? body.room_type_id,
        seasonId: body.seasonId ?? body.season_id,
        mealPlan: body.mealPlan ?? body.meal_plan,
        concept: body.concept || null,
        priceKind: body.priceKind ?? body.price_kind,
        occupancy: body.occupancy || null,
        pricingUnit: body.pricingUnit ?? body.pricing_unit,
        netRate: body.netRate ?? body.net_rate,
        markupPercent: markupRaw !== undefined && markupRaw !== null && markupRaw !== '' ? Number(markupRaw) : null,
        sellRate: sellRateRaw !== undefined && sellRateRaw !== null && sellRateRaw !== '' ? Number(sellRateRaw) : null,
        percentOfAdult: percentAdultRaw !== undefined && percentAdultRaw !== null && percentAdultRaw !== '' ? Number(percentAdultRaw) : null,
        childAgeMin: (body.childAgeMin ?? body.child_age_min) ?? null,
        childAgeMax: (body.childAgeMax ?? body.child_age_max) ?? null,
        daysOfWeek: body.daysOfWeek ?? body.days_of_week ?? [],
        minNights: Number(body.minNights ?? body.min_nights) || 1,
        maxNights: (body.maxNights ?? body.max_nights) ? Number(body.maxNights ?? body.max_nights) : null,
        packageNights: (body.packageNights ?? body.package_nights) ? Number(body.packageNights ?? body.package_nights) : null,
        sourcePage: (body.sourcePage ?? body.source_page) ? Number(body.sourcePage ?? body.source_page) : null,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : (body.is_active !== undefined ? Boolean(body.is_active) : true),
      },
    });
    await ratesService.bumpCatalogCache();
    res.status(201).json({ data: rate });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/rates/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.rate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Rate not found');

    const body = req.body;
    const data: any = {};
    if (body.roomTypeId !== undefined || body.room_type_id !== undefined) data.roomTypeId = body.roomTypeId ?? body.room_type_id;
    if (body.seasonId !== undefined || body.season_id !== undefined) data.seasonId = body.seasonId ?? body.season_id;
    if (body.mealPlan !== undefined || body.meal_plan !== undefined) data.mealPlan = body.mealPlan ?? body.meal_plan;
    if (body.concept !== undefined) data.concept = body.concept || null;
    if (body.priceKind !== undefined || body.price_kind !== undefined) data.priceKind = body.priceKind ?? body.price_kind;
    if (body.occupancy !== undefined) data.occupancy = body.occupancy ? Number(body.occupancy) : null;
    if (body.pricingUnit !== undefined || body.pricing_unit !== undefined) data.pricingUnit = body.pricingUnit ?? body.pricing_unit;
    if (body.netRate !== undefined || body.net_rate !== undefined) data.netRate = body.netRate ?? body.net_rate;
    if (body.markupPercent !== undefined || body.markup_percent !== undefined) {
      const raw = body.markupPercent !== undefined ? body.markupPercent : body.markup_percent;
      data.markupPercent = raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }
    if (body.sellRate !== undefined || body.sell_rate !== undefined) {
      const raw = body.sellRate !== undefined ? body.sellRate : body.sell_rate;
      data.sellRate = raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }
    if (body.percentOfAdult !== undefined || body.percent_of_adult !== undefined) {
      const raw = body.percentOfAdult !== undefined ? body.percentOfAdult : body.percent_of_adult;
      data.percentOfAdult = raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }
    if (body.childAgeMin !== undefined || body.child_age_min !== undefined) data.childAgeMin = (body.childAgeMin ?? body.child_age_min) ?? null;
    if (body.childAgeMax !== undefined || body.child_age_max !== undefined) data.childAgeMax = (body.childAgeMax ?? body.child_age_max) ?? null;
    if (body.daysOfWeek !== undefined || body.days_of_week !== undefined) data.daysOfWeek = body.daysOfWeek ?? body.days_of_week;
    if (body.minNights !== undefined || body.min_nights !== undefined) data.minNights = Number(body.minNights ?? body.min_nights);
    if (body.maxNights !== undefined || body.max_nights !== undefined) data.maxNights = (body.maxNights ?? body.max_nights) ? Number(body.maxNights ?? body.max_nights) : null;
    if (body.packageNights !== undefined || body.package_nights !== undefined) data.packageNights = (body.packageNights ?? body.package_nights) ? Number(body.packageNights ?? body.package_nights) : null;
    if (body.sourcePage !== undefined || body.source_page !== undefined) data.sourcePage = (body.sourcePage ?? body.source_page) ? Number(body.sourcePage ?? body.source_page) : null;
    if (body.isActive !== undefined || body.is_active !== undefined) data.isActive = Boolean(body.isActive ?? body.is_active);

    const rate = await prisma.rate.update({
      where: { id },
      data,
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: rate });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/hotels/:id/payment-methods', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.hotel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Hotel not found');

    const { methods } = req.body; // array of { method, iva_rate / ivaRate, surcharge_percent / surchargePercent }
    if (!Array.isArray(methods)) {
      throw new ValidationError('methods must be an array');
    }

    await prisma.$transaction(async (tx) => {
      await tx.hotelPaymentTaxRule.deleteMany({ where: { hotelId: id } });
      for (const m of methods) {
        let ivaRate = Number(m.ivaRate !== undefined ? m.ivaRate : m.iva_rate);
        if (!Number.isFinite(ivaRate) || ivaRate < 0) {
          throw new ValidationError(`Invalid iva_rate for method ${m.method}`);
        }
        if (ivaRate > 1) {
          ivaRate = ivaRate / 100;
        }
        if (ivaRate >= 10) {
          throw new ValidationError(
            `iva_rate for ${m.method} must be a fraction (e.g. 0.16) or percent up to 100`
          );
        }

        const surcharge = m.surchargePercent !== undefined ? m.surchargePercent : m.surcharge_percent;
        await tx.hotelPaymentTaxRule.create({
          data: {
            hotelId: id,
            method: m.method,
            ivaRate,
            surchargePercent: surcharge !== undefined && surcharge !== null && surcharge !== '' ? Number(surcharge) : null,
          },
        });
      }
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  '/hotels/:id/images',
  requireRole('admin'),
  imageUploadMiddleware,
  async (req, res, next) => {
    try {
      const hotelId = req.params.id as string;
      const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
      if (!hotel) throw new NotFoundError('Hotel not found');

      const imageId = crypto.randomUUID();
      const webpBuffer = await sharp(req.file!.buffer)
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      const key = `private/hotels/${hotelId}/${imageId}.webp`;
      await fileStorage.put(key, webpBuffer, { contentType: 'image/webp' });

      const isPrimary =
        req.body.isPrimary === 'true' ||
        req.body.isPrimary === true ||
        req.body.is_primary === 'true' ||
        req.body.is_primary === true ||
        req.body.tag === 'cover' ||
        Number(req.body.sort_order) === 0;

      const image = await prisma.hotelImage.create({
        data: {
          id: imageId,
          hotelId,
          key,
          status: 'held',
          sortOrder: Number(req.body.sort_order) || 0,
          alt: req.body.alt || null,
        },
      });

      if (isPrimary || !hotel.coverImageKey) {
        await prisma.hotel.update({
          where: { id: hotelId },
          data: {
            coverImageKey: key,
            coverImageUrl: `${env.FILES_PUBLIC_BASE_URL}/${key.replace(/^private\//, 'public/')}`,
          },
        });
      }

      await ratesService.bumpCatalogCache();
      res.status(201).json({ data: image });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch('/images/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const image = await prisma.hotelImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundError('Image not found');

    const { status, sort_order, alt } = req.body;
    let newKey = image.key;

    if (status && status !== image.status) {
      if (status === 'published' && image.status === 'held') {
        newKey = image.key.replace(/^private\//, 'public/');
        await fileStorage.move(image.key, newKey);
      } else if (status === 'held' && image.status === 'published') {
        newKey = image.key.replace(/^public\//, 'private/');
        await fileStorage.move(image.key, newKey);
      }
    }

    const updated = await prisma.hotelImage.update({
      where: { id },
      data: {
        key: newKey,
        status: status || image.status,
        sortOrder: sort_order !== undefined ? Number(sort_order) : image.sortOrder,
        alt: alt !== undefined ? alt : image.alt,
      },
    });

    if (
      updated.sortOrder === 0 ||
      req.body.isPrimary === true ||
      req.body.tag === 'cover'
    ) {
      await prisma.hotel.update({
        where: { id: image.hotelId },
        data: {
          coverImageKey: newKey,
          coverImageUrl: `${env.FILES_PUBLIC_BASE_URL}/${newKey.replace(/^private\//, 'public/')}`,
        },
      });
    }

    await ratesService.bumpCatalogCache();
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/images/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const image = await prisma.hotelImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundError('Image not found');

    await fileStorage.delete(image.key);
    await prisma.hotelImage.delete({ where: { id } });

    const hotel = await prisma.hotel.findUnique({ where: { id: image.hotelId } });
    if (hotel?.coverImageKey === image.key) {
      const nextImg = await prisma.hotelImage.findFirst({
        where: { hotelId: image.hotelId },
        orderBy: { sortOrder: 'asc' },
      });
      await prisma.hotel.update({
        where: { id: image.hotelId },
        data: {
          coverImageKey: nextImg ? nextImg.key : null,
          coverImageUrl: nextImg
            ? `${env.FILES_PUBLIC_BASE_URL}/${nextImg.key.replace(/^private\//, 'public/')}`
            : null,
        },
      });
    }

    await ratesService.bumpCatalogCache();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});


adminRouter.get('/exchange-rates', requireRole('admin'), async (_req, res, next) => {
  try {
    const history = await prisma.exchangeRate.findMany({
      orderBy: { recordedAt: 'desc' },
      take: 50,
    });
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/exchange-rates/manual', requireRole('admin'), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const bcvUsd = Number(body.bcv_usd ?? body.bcvUsd);
    const bcvEur = Number(body.bcv_eur ?? body.bcvEur);
    const binanceUsdt = Number(body.binance_usdt ?? body.binanceUsdt);
    const bcvValueDate = body.bcv_value_date ?? body.bcvValueDate;

    if (![bcvUsd, bcvEur, binanceUsdt].every((n) => Number.isFinite(n) && n > 0)) {
      throw new ValidationError('bcv_usd, bcv_eur, and binance_usdt must be positive numbers');
    }

    const effective = await ratesService.setManualRate({
      bcvUsd,
      bcvEur,
      binanceUsdt,
      bcvValueDate,
    });
    await ratesService.bumpCatalogCache();
    res.json({ data: effective });
  } catch (err) {
    next(err);
  }
});


adminRouter.get('/holidays', requireRole('admin'), async (_req, res, next) => {
  try {
    const holidays = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
    res.json({ data: holidays });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/holidays', requireRole('admin'), async (req, res, next) => {
  try {
    const date = new Date(`${req.body.date}T00:00:00Z`);
    const holiday = await prisma.holiday.create({
      data: { date, name: req.body.name },
    });
    res.status(201).json({ data: holiday });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/holidays/:date', requireRole('admin'), async (req, res, next) => {
  try {
    const date = new Date(`${req.params.date}T00:00:00Z`);
    await prisma.holiday.delete({ where: { date } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});


adminRouter.get('/quotes', requireRole('agent'), async (_req, res, next) => {
  try {
    const quotes = await prisma.quote.findMany({ orderBy: { expiresAt: 'desc' } });
    res.json({ data: quotes });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/quotes', requireRole('agent'), async (req, res, next) => {
  try {
    const code = generateQuoteCode();
    const tokenKey = crypto.randomUUID();
    const body = req.body || {};
    const commPct = body.commissionPercent !== undefined ? body.commissionPercent : body.commission_percent;
    const commAmt = body.commissionAmount !== undefined ? body.commissionAmount : body.commission_amount;
    const notes = body.internalNotes !== undefined ? body.internalNotes : body.internal_notes;
    const expiresAt = body.expiresAt ?? body.expires_at;

    const quote = await prisma.quote.create({
      data: {
        code,
        tokenKey,
        lines: body.lines || [],
        commissionPercent: commPct !== undefined ? Number(commPct) : 10,
        commissionAmount: commAmt !== undefined ? Number(commAmt) : 0,
        internalNotes: notes || null,
        expiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days
      },
    });
    res.status(201).json({ data: quote });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/quotes/:id', requireRole('agent'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote) throw new NotFoundError('Quote not found');

    const body = req.body || {};
    if (body.status === 'accepted') {
      if (
        quote.status === 'declined' ||
        quote.status === 'expired' ||
        quote.expiresAt < new Date()
      ) {
        throw new InvalidTransitionError('Cannot accept a declined or expired quote');
      }
    }

    const data: any = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.lines !== undefined) data.lines = body.lines;
    if (body.commissionPercent !== undefined || body.commission_percent !== undefined) {
      const val = body.commissionPercent !== undefined ? body.commissionPercent : body.commission_percent;
      data.commissionPercent = Number(val);
    }
    if (body.commissionAmount !== undefined || body.commission_amount !== undefined) {
      const val = body.commissionAmount !== undefined ? body.commissionAmount : body.commission_amount;
      data.commissionAmount = Number(val);
    }
    if (body.internalNotes !== undefined || body.internal_notes !== undefined) {
      data.internalNotes = (body.internalNotes ?? body.internal_notes) || null;
    }
    if (body.expiresAt !== undefined || body.expires_at !== undefined) {
      const exp = body.expiresAt ?? body.expires_at;
      data.expiresAt = exp ? new Date(exp) : undefined;
    }

    const updated = await prisma.quote.update({
      where: { id },
      data,
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});


adminRouter.post('/tarifario/imports', requireRole('admin'), async (req, res, next) => {
  try {
    const plan = await tarifarioService.dryRun(req.body);
    res.json({ data: plan });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/tarifario/imports/:id/commit', requireRole('admin'), async (req, res, next) => {
  try {
    const { expected_hash } = req.body;
    const result = await tarifarioService.commit(req.params.id as string, expected_hash);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});


adminRouter.get('/users', requireRole('super_admin'), async (_req, res, next) => {
  try {
    const users = await prisma.staffUser.findMany({
      select: { id: true, email: true, role: true },
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users', requireRole('super_admin'), async (req, res, next) => {
  try {
    const hash = await argon2.hash(req.body.password, { type: argon2.argon2id });
    const user = await prisma.staffUser.create({
      data: {
        email: req.body.email.toLowerCase(),
        passwordHash: hash,
        role: req.body.role || 'agent',
      },
      select: { id: true, email: true, role: true },
    });
    res.status(201).json({ data: user });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/users/:id/role', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.staffUser.update({
      where: { id },
      data: { role: req.body.role },
      select: { id: true, email: true, role: true },
    });
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users/:id/reset-password', requireRole('super_admin'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const hash = await argon2.hash(req.body.password, { type: argon2.argon2id });
    await prisma.staffUser.update({
      where: { id },
      data: { passwordHash: hash },
    });
    await prisma.session.deleteMany({ where: { userId: id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});


const checkoutSettingsUpdateSchema = z.object({
  pay_now_enabled: z.boolean().optional(),
  payNowEnabled: z.boolean().optional(),
  pay_at_hotel_enabled: z.boolean().optional(),
  payAtHotelEnabled: z.boolean().optional(),
  card_payments_enabled: z.boolean().optional(),
  cardPaymentsEnabled: z.boolean().optional(),
  payment_window_hours: z.number().int().min(1).max(168).optional(),
  paymentWindowHours: z.number().int().min(1).max(168).optional(),
  reminder_offsets_pct: z.array(z.number().int().min(1).max(99)).optional(),
  reminderOffsetsPct: z.array(z.number().int().min(1).max(99)).optional(),
  auto_confirm_after_payment: z.boolean().optional(),
  autoConfirmAfterPayment: z.boolean().optional(),
});

function formatCheckoutSettingsResponse(settings: any) {
  return {
    ...settings,
    pay_now_enabled: settings.payNowEnabled,
    pay_at_hotel_enabled: settings.payAtHotelEnabled,
    card_payments_enabled: settings.cardPaymentsEnabled,
    payment_window_hours: settings.paymentWindowHours,
    reminder_offsets_pct: settings.reminderOffsetsPct,
    auto_confirm_after_payment: settings.autoConfirmAfterPayment,
  };
}

adminRouter.get('/settings/checkout', requireRole('agent'), async (_req, res, next) => {
  try {
    const settings = await settingsService.getGlobalCheckoutSettings();
    res.json({ data: formatCheckoutSettingsResponse(settings) });
  } catch (err) {
    next(err);
  }
});

adminRouter.put(
  '/settings/checkout',
  requireRole('admin'),
  validate({ body: checkoutSettingsUpdateSchema }),
  async (req, res, next) => {
    try {
      const payNowEnabled = req.body.payNowEnabled ?? req.body.pay_now_enabled;
      const payAtHotelEnabled = req.body.payAtHotelEnabled ?? req.body.pay_at_hotel_enabled;
      const cardPaymentsEnabled = req.body.cardPaymentsEnabled ?? req.body.card_payments_enabled;
      const paymentWindowHours = req.body.paymentWindowHours ?? req.body.payment_window_hours;
      const reminderOffsetsPct = req.body.reminderOffsetsPct ?? req.body.reminder_offsets_pct;
      const autoConfirmAfterPayment = req.body.autoConfirmAfterPayment ?? req.body.auto_confirm_after_payment;

      const updated = await settingsService.updateGlobalCheckoutSettings(
        {
          payNowEnabled,
          payAtHotelEnabled,
          cardPaymentsEnabled,
          paymentWindowHours,
          reminderOffsetsPct,
          autoConfirmAfterPayment,
        },
        { id: req.user!.id, type: req.user!.role }
      );

      res.json({ data: formatCheckoutSettingsResponse(updated) });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get('/hotels/:id/checkout-options', requireRole('agent'), async (req, res, next) => {
  try {
    const options = await settingsService.getHotelCheckoutOptions(req.params.id as string);
    res.json({
      data: {
        overrides: {
          ...options.overrides,
          pay_now_enabled: options.overrides.payNowEnabled,
          pay_at_hotel_enabled: options.overrides.payAtHotelEnabled,
          payment_window_hours: options.overrides.paymentWindowHours,
          reminder_offsets_pct: options.overrides.reminderOffsetsPct,
          auto_confirm_after_payment: options.overrides.autoConfirmAfterPayment,
        },
        effective: {
          ...options.effective,
          pay_now_enabled: options.effective.payNowEnabled,
          pay_at_hotel_enabled: options.effective.payAtHotelEnabled,
          card_payments_enabled: options.effective.cardPaymentsEnabled,
          payment_window_hours: options.effective.paymentWindowHours,
          reminder_offsets_pct: options.effective.reminderOffsetsPct,
          auto_confirm_after_payment: options.effective.autoConfirmAfterPayment,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

const hotelCheckoutOptionsUpdateSchema = z.object({
  pay_now_enabled: z.boolean().nullable().optional(),
  payNowEnabled: z.boolean().nullable().optional(),
  pay_at_hotel_enabled: z.boolean().nullable().optional(),
  payAtHotelEnabled: z.boolean().nullable().optional(),
  payment_window_hours: z.number().int().min(1).max(168).nullable().optional(),
  paymentWindowHours: z.number().int().min(1).max(168).nullable().optional(),
  reminder_offsets_pct: z.array(z.number().int().min(1).max(99)).nullable().optional(),
  reminderOffsetsPct: z.array(z.number().int().min(1).max(99)).nullable().optional(),
  auto_confirm_after_payment: z.boolean().nullable().optional(),
  autoConfirmAfterPayment: z.boolean().nullable().optional(),
});

adminRouter.put(
  '/hotels/:id/checkout-options',
  requireRole('admin'),
  validate({ body: hotelCheckoutOptionsUpdateSchema }),
  async (req, res, next) => {
    try {
      const payNowEnabled = req.body.payNowEnabled !== undefined ? req.body.payNowEnabled : req.body.pay_now_enabled;
      const payAtHotelEnabled = req.body.payAtHotelEnabled !== undefined ? req.body.payAtHotelEnabled : req.body.pay_at_hotel_enabled;
      const paymentWindowHours = req.body.paymentWindowHours !== undefined ? req.body.paymentWindowHours : req.body.payment_window_hours;
      const reminderOffsetsPct = req.body.reminderOffsetsPct !== undefined ? req.body.reminderOffsetsPct : req.body.reminder_offsets_pct;
      const autoConfirmAfterPayment = req.body.autoConfirmAfterPayment !== undefined ? req.body.autoConfirmAfterPayment : req.body.auto_confirm_after_payment;

      const result = await settingsService.updateHotelCheckoutOptions(
        req.params.id as string,
        {
          payNowEnabled,
          payAtHotelEnabled,
          paymentWindowHours,
          reminderOffsetsPct,
          autoConfirmAfterPayment,
        },
        { id: req.user!.id, type: req.user!.role }
      );

      res.json({
        data: {
          overrides: {
            ...result.overrides,
            pay_now_enabled: result.overrides.payNowEnabled,
            pay_at_hotel_enabled: result.overrides.payAtHotelEnabled,
            payment_window_hours: result.overrides.paymentWindowHours,
            reminder_offsets_pct: result.overrides.reminderOffsetsPct,
            auto_confirm_after_payment: result.overrides.autoConfirmAfterPayment,
          },
          effective: {
            ...result.effective,
            pay_now_enabled: result.effective.payNowEnabled,
            pay_at_hotel_enabled: result.effective.payAtHotelEnabled,
            card_payments_enabled: result.effective.cardPaymentsEnabled,
            payment_window_hours: result.effective.paymentWindowHours,
            reminder_offsets_pct: result.effective.reminderOffsetsPct,
            auto_confirm_after_payment: result.effective.autoConfirmAfterPayment,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get('/refunds', requireRole('agent'), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const data = await adminRefundService.list({
      status: q.status,
      hotelId: q.hotelId || q.hotel_id,
      paymentMethod: q.paymentMethod || q.payment_method,
      from: q.from,
      to: q.to,
      page: q.page ? parseInt(q.page, 10) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/refunds/:id', requireRole('agent'), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const data = await adminRefundService.getDetail(id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  '/refunds/:id/request-info',
  requireRole('agent'),
  validate({
    body: z.object({
      message: z.string().min(1).max(2000),
    }),
  }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const data = await adminRefundService.requestInfo(id, refundActor(req.user!), req.body.message);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/refunds/:id/approve',
  requireRole('admin'),
  validate({
    body: z.object({
      approved_amount: z.number().positive(),
      approved_currency: z.string().min(3).max(4),
      note: z.string().max(1000).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const data = await adminRefundService.approve(id, refundActor(req.user!), req.body);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/refunds/:id/reject',
  requireRole('admin'),
  validate({
    body: z.object({
      reason: z.string().min(1).max(2000),
    }),
  }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const data = await adminRefundService.reject(id, refundActor(req.user!), req.body.reason);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/refunds/:id/complete',
  requireRole('admin'),
  (req, res, next) => {
    refundUploadMiddleware(req, res, (err) => {
      if (err) next(err);
      else next();
    });
  },
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const reference =
        typeof req.body?.refund_reference === 'string' ? req.body.refund_reference : '';
      const files = (req.files as Express.Multer.File[]) || [];
      const proofFile = files[0];
      const data = await adminRefundService.complete(id, refundActor(req.user!), {
        refund_reference: reference,
        proofFile,
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get('/settings/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const { settingType, setting_type, targetId, target_id, limit } = req.query as any;
    const audit = await settingsService.getSettingsAudit({
      settingType: settingType || setting_type,
      targetId: targetId || target_id,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ data: audit });
  } catch (err) {
    next(err);
  }
});
