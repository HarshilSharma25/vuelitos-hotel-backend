import { z } from 'zod';

export const tarifarioRateSchema = z.object({
  room_name: z.string().min(1),
  season_name: z.string().min(1),
  meal_plan: z.string().min(1),
  concept: z.enum(['OCUPACION', 'NINO', 'PAX_ADICIONAL']).nullable().default(null),
  price_kind: z.enum(['IMPORTE', 'BAJO_PEDIDO', 'GRATIS', 'PORCENTAJE_ADULTO']),
  occupancy: z.number().int().min(1).nullable().default(null),
  pricing_unit: z.enum(['per_room', 'per_person']),
  net_rate: z.number().min(0),
  days_of_week: z.array(z.number().int().min(0).max(6)).default([]),
  min_nights: z.number().int().min(1).default(1),
  max_nights: z.number().int().min(1).nullable().default(null),
  child_age_min: z.number().int().min(0).nullable().default(null),
  child_age_max: z.number().int().min(0).nullable().default(null),
});

export const tarifarioSeasonSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().default(1),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  booking_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  booking_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

export const tarifarioRoomSchema = z.object({
  name: z.string().min(1),
  max_occupancy: z.number().int().min(1),
});

export const tarifarioHotelSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  destination: z.string().min(1),
  category: z.string().min(1),
  currency: z.enum(['USD', 'EUR']),
  is_solo_divisas: z.boolean().default(false),
  rooms: z.array(tarifarioRoomSchema).min(1),
  seasons: z.array(tarifarioSeasonSchema).min(1),
  rates: z.array(tarifarioRateSchema),
});

export const tarifarioSchema = z.object({
  format_version: z.literal('1.0'),
  source: z.string().min(1),
  hotels: z.array(tarifarioHotelSchema).min(1),
});

export type TarifarioDocument = z.infer<typeof tarifarioSchema>;
export type TarifarioHotel = z.infer<typeof tarifarioHotelSchema>;
export type TarifarioRate = z.infer<typeof tarifarioRateSchema>;
