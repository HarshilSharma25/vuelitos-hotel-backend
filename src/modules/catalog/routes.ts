import { Router } from 'express';
import { z } from 'zod';
import { catalogService } from './service.js';
import { sendData } from '../../middleware/response.js';
import { validate } from '../../middleware/validate.js';
import {
  catalogSearchResponseSchema,
  checkoutPriceResponseSchema,
  destinationsResponseSchema,
  hotelDetailSchema,
} from './schemas.js';

export const catalogRouter = Router();

catalogRouter.get('/destinations', async (_req, res, next) => {
  try {
    const data = await catalogService.getDestinations();
    sendData(res, destinationsResponseSchema, data);
  } catch (err) {
    next(err);
  }
});

const searchHotelsQuerySchema = z.object({
  destination: z.string().optional(),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults: z.coerce.number().optional(),
  children: z.coerce.number().optional(),
  rooms: z.coerce.number().optional(),
  meal_plan: z.string().optional(),
  max_price: z.coerce.number().optional(),
  category: z.string().optional(),
  q: z.string().optional(),
  sort: z.enum(['price_asc', 'price_desc', 'stars_desc']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().optional(),
});

catalogRouter.get(
  '/hotels',
  validate({ query: searchHotelsQuerySchema }),
  async (req, res, next) => {
    try {
      const { data, meta } = await catalogService.searchHotels(req.query as any);
      sendData(res, catalogSearchResponseSchema, data, meta);
    } catch (err) {
      next(err);
    }
  }
);

const hotelDetailQuerySchema = z.object({
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults: z.coerce.number().optional(),
  children: z.coerce.number().optional(),
  rooms: z.coerce.number().optional(),
});

catalogRouter.get(
  '/hotels/:slug',
  validate({ query: hotelDetailQuerySchema }),
  async (req, res, next) => {
    try {
      const slug = req.params.slug as string;
      const data = await catalogService.getHotelDetail(slug, req.query as any);
      sendData(res, hotelDetailSchema, data);
    } catch (err) {
      next(err);
    }
  }
);

const priceRequestSchema = z.object({
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

catalogRouter.post(
  '/hotels/:slug/price',
  validate({ body: priceRequestSchema }),
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const slug = req.params.slug as string;
      const data = await catalogService.priceCheckout(slug, req.body);
      sendData(res, checkoutPriceResponseSchema, data);
    } catch (err) {
      next(err);
    }
  }
);
