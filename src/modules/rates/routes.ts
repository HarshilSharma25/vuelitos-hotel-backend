import { Router } from 'express';
import { z } from 'zod';
import { ratesService } from './service.js';
import { sendData } from '../../middleware/response.js';

export const exchangeSchema = z.object({
  available: z.boolean(),
  bcv_usd: z.number().nullable(),
  bcv_eur: z.number().nullable(),
  binance_usdt: z.number().nullable(),
  bcv_value_date: z.string().nullable(),
  stale: z.boolean(),
});

export const ratesRouter = Router();

ratesRouter.get('/exchange-rates', async (_req, res, next) => {
  try {
    const rates = await ratesService.getLatestEffectiveRates();
    sendData(res, exchangeSchema, rates);
  } catch (err) {
    next(err);
  }
});
