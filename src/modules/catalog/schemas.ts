import { z } from 'zod';
import { exchangeSchema } from '../rates/routes.js';

export const moneySchema = z.object({
  base: z.number(),
  bs: z.number().nullable(),
  usdt: z.number(),
});

export const destinationItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  hotel_count: z.number(),
});

export const destinationsResponseSchema = z.object({
  destinations: z.array(destinationItemSchema),
});

export const hotelCardSchema = z.object({
  slug: z.string(),
  name: z.string(),
  destination: z.string(),
  category: z.string(),
  star_rating: z.number().nullable(),
  starRating: z.number().nullable().optional(),
  base_currency: z.enum(['USD', 'EUR']),
  baseCurrency: z.enum(['USD', 'EUR']).optional(),
  is_solo_divisas: z.boolean(),
  isSoloDivisas: z.boolean().optional(),
  image_url: z.string().nullable(),
  cover_image_url: z.string().nullable().optional(),
  coverImageUrl: z.string().nullable().optional(),
  cover_image_key: z.string().nullable().optional(),
  coverImageKey: z.string().nullable().optional(),
  meal_plans: z.array(z.string()),
  rooms_quoted: z.number(),
  price: moneySchema.nullable(),
  price_basis: z.enum(['per_night_from', 'stay_total']),
  availability: z.enum(['ok', 'no_season', 'no_rate', 'min_nights']),
  min_nights_required: z.number().optional(),
});

export const catalogSearchResponseSchema = z.object({
  items: z.array(hotelCardSchema),
  exchange: exchangeSchema,
});

export const methodTotalSchema = z.object({
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
  iva_rate: z.number(),
  iva_amount: z.number(),
  exchange_rate_used: z.number().nullable(),
  is_lowest: z.boolean(),
});

export const stayOptionSchema = z.discriminatedUnion('priced', [
  z.object({
    id: z.string(),
    room_type_id: z.string(),
    room_name: z.string(),
    meal_plan: z.string(),
    fits_party: z.boolean(),
    priced: z.literal(true),
    total: moneySchema,
    methods: z.array(methodTotalSchema),
  }),
  z.object({
    id: z.string(),
    room_type_id: z.string(),
    room_name: z.string(),
    meal_plan: z.string(),
    fits_party: z.boolean(),
    priced: z.literal(false),
    reason: z.enum(['no_season', 'no_rate', 'min_nights']),
    min_nights_required: z.number().optional(),
  }),
]);

export const groupRequestSchema = z.object({
  whatsapp_url: z.string(),
  email: z.string(),
});

export const hotelDetailSchema = z.object({
  hotel: z.object({
    slug: z.string(),
    name: z.string(),
    destination: z.string(),
    category: z.string(),
    star_rating: z.number().nullable(),
    starRating: z.number().nullable().optional(),
    base_currency: z.enum(['USD', 'EUR']),
    baseCurrency: z.enum(['USD', 'EUR']).optional(),
    is_solo_divisas: z.boolean(),
    isSoloDivisas: z.boolean().optional(),
    description: z.string().nullable(),
    cover_image_url: z.string().nullable().optional(),
    coverImageUrl: z.string().nullable().optional(),
    cover_image_key: z.string().nullable().optional(),
    coverImageKey: z.string().nullable().optional(),
    images: z.array(
      z.object({
        id: z.string().optional(),
        key: z.string().optional(),
        url: z.string(),
        alt: z.string().nullable().optional(),
        sort_order: z.number().optional(),
        sortOrder: z.number().optional(),
      })
    ),
    meal_plans: z.array(z.string()),
  }),
  rooms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      max_occupancy: z.number(),
    })
  ),
  seasonal_rates: z.array(
    z.object({
      season: z.string(),
      date_from: z.string(),
      date_to: z.string(),
      rows: z.array(
        z.object({
          room_type_id: z.string(),
          meal_plan: z.string(),
          occupancy: z.number(),
          per: z.enum(['room', 'person']),
          price: moneySchema,
          min_nights: z.number(),
        })
      ),
    })
  ),
  from_price: z
    .object({
      price: moneySchema,
      per: z.literal('night'),
    })
    .nullable(),
  stay: z
    .object({
      nights: z.number(),
      rooms_effective: z.number(),
      options: z.array(stayOptionSchema),
      lowest_option_id: z.string().nullable(),
    })
    .nullable(),
  availability: z.object({
    mode: z.enum(['manual', 'api']),
    status: z.enum(['on_request', 'available', 'unavailable']),
    last_checked_at: z.string().nullable(),
  }),
  group_request: groupRequestSchema.nullable(),
  exchange: exchangeSchema,
});

export const checkoutPriceResponseSchema = z.discriminatedUnion('priced', [
  z.object({
    priced: z.literal(true),
    nights: z.number(),
    base_currency: z.enum(['USD', 'EUR']),
    rooms: z.array(
      z.object({
        room_type_id: z.string(),
        guests: z.number(),
        price: moneySchema,
      })
    ),
    total: moneySchema,
    methods: z.array(methodTotalSchema),
    exchange: exchangeSchema,
  }),
  z.object({
    priced: z.literal(false),
    reason: z.enum(['no_season', 'no_rate', 'min_nights', 'group_request']),
    min_nights_required: z.number().optional(),
    group_request: groupRequestSchema.optional(),
  }),
]);
