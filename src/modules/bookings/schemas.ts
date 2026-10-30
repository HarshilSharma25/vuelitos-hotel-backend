import { z } from 'zod';
import { moneySchema, methodTotalSchema } from '../catalog/schemas.js';

export const bookingCreateItemSchema = z.object({
  type: z.literal('hotel_stay'),
  hotel_slug: z.string(),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meal_plan: z.string(),
  room_selections: z
    .array(
      z.object({
        room_type_id: z.string(),
        adults: z.number().int().min(1).max(20),
        children: z.number().int().min(0).max(20),
        child_ages: z.array(z.number().int()).default([]),
      })
    )
    .min(1)
    .max(10),
});

export const bookingCreateSchema = z.object({
  items: z.array(bookingCreateItemSchema).min(1).max(5),
  contact: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(254).toLowerCase(),
    phone: z.string().trim().max(30).optional(),
  }),
  locale: z.enum(['es', 'en']).default('es'),
  payment_method: z
    .enum([
      'stripe_card',
      'pago_movil',
      'bs_transfer',
      'zelle',
      'usdt_binance',
      'cash_usd',
      'cash_eur',
    ])
    .optional(),
  notes: z.string().trim().max(1000).optional(),
  terms_accepted: z.literal(true),
  website: z.string().optional().default(''), // Honeypot
});

export const bookingCreatedResponseSchema = z.object({
  code: z.string(),
  access_token: z.string(),
  status: z.literal('requested'),
  sla_due_at: z.string(),
});

export const bookingPublicViewSchema = z.object({
  code: z.string(),
  status: z.enum([
    'requested',
    'checking_availability',
    'awaiting_payment',
    'payment_submitted',
    'payment_verified',
    'confirmed',
    'alternatives_offered',
    'unavailable',
    'cancelled',
    'refund_pending',
    'refunded',
  ]),
  status_label: z.string(),
  status_description: z.string(),
  sla_due_at: z.string().nullable(),
  payment_due_at: z.string().nullable(),
  contact: z.object({
    name: z.string(),
    email: z.string(),
  }),
  items: z.array(
    z.object({
      type: z.literal('hotel_stay'),
      hotel: z.object({
        slug: z.string(),
        name: z.string(),
        destination: z.string(),
      }),
      check_in: z.string(),
      check_out: z.string(),
      nights: z.number(),
      meal_plan: z.string(),
      rooms: z.array(
        z.object({
          room_type_id: z.string(),
          room_name: z.string(),
          adults: z.number(),
          children: z.number(),
          child_ages: z.array(z.number()),
        })
      ),
      price: moneySchema,
    })
  ),
  totals_by_method: z.array(methodTotalSchema),
  exchange_snapshot: z.object({
    bcv_usd: z.number().nullable(),
    bcv_eur: z.number().nullable(),
    binance_usdt: z.number().nullable(),
    bcv_value_date: z.string().nullable(),
  }),
  payments: z.array(
    z.object({
      id: z.string(),
      method: z.enum([
        'stripe_card',
        'pago_movil',
        'bs_transfer',
        'zelle',
        'usdt_binance',
        'cash_usd',
        'cash_eur',
      ]),
      currency: z.enum(['VES', 'USD', 'EUR', 'USDT']),
      amount: z.number(),
      reference: z.string(),
      status: z.enum(['submitted', 'verified', 'rejected', 'refunded']),
      submitted_at: z.string(),
    })
  ),
  timeline: z.array(
    z.object({
      at: z.string(),
      event: z.string(),
      label: z.string(),
    })
  ),
  allowed_actions: z.array(z.enum(['report_payment', 'cancel'])),
  created_at: z.string(),
});

export const reportPaymentSchema = z.object({
  token: z.string().min(10).optional(),
  method: z.enum([
    'stripe_card',
    'pago_movil',
    'bs_transfer',
    'zelle',
    'usdt_binance',
    'cash_usd',
    'cash_eur',
  ]),
  reference: z.string().trim().min(1).max(100),
});

export const cancelBookingSchema = z.object({
  token: z.string().min(10).optional(),
});
