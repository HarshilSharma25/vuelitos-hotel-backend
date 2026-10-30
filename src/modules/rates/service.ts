import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getCaracasWallDate } from '../../lib/caracas-time.js';
import { FxRates } from '../pricing/types.js';

export interface ExchangeApiResponse {
  available: boolean;
  bcv_usd: number | null;
  bcv_eur: number | null;
  binance_usdt: number | null;
  bcv_value_date: string | null;
  stale: boolean;
}

export class RatesService {
  async getLatestEffectiveRates(): Promise<ExchangeApiResponse> {
    try {
      const cached = await redis.get('exchange:latest');
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis error should not block database read
    }

    const todayCaracas = getCaracasWallDate();
    const todayDate = new Date(`${todayCaracas}T00:00:00Z`);

    // 1. Fetch latest manual override
    const manualRate = await prisma.exchangeRate.findFirst({
      where: { isManualOverride: true },
      orderBy: { recordedAt: 'desc' },
    });

    // 2. Fetch latest auto rate with valueDate <= today Caracas
    const autoRate = await prisma.exchangeRate.findFirst({
      where: {
        isManualOverride: false,
        bcvValueDate: { lte: todayDate },
      },
      orderBy: { recordedAt: 'desc' },
    });

    // Determine which rate applies: newest auto unless newer manual override exists
    let chosen = autoRate;
    if (manualRate) {
      if (!autoRate || manualRate.recordedAt >= autoRate.recordedAt) {
        chosen = manualRate;
      }
    }

    if (!chosen) {
      const fallback: ExchangeApiResponse = {
        available: false,
        bcv_usd: null,
        bcv_eur: null,
        binance_usdt: null,
        bcv_value_date: null,
        stale: true,
      };
      return fallback;
    }

    const now = Date.now();
    const ageMs = now - chosen.recordedAt.getTime();
    const isStale = ageMs > 24 * 60 * 60 * 1000;

    const valueDateStr = chosen.bcvValueDate.toISOString().slice(0, 10);

    const result: ExchangeApiResponse = {
      available: true,
      bcv_usd: Number(chosen.bcvUsd),
      bcv_eur: Number(chosen.bcvEur),
      binance_usdt: Number(chosen.binanceUsdt),
      bcv_value_date: valueDateStr,
      stale: isStale,
    };

    try {
      await redis.set('exchange:latest', JSON.stringify(result), 'EX', 60);
    } catch {
      // Ignore Redis caching error
    }

    return result;
  }

  async setManualRate(params: {
    bcvUsd: number;
    bcvEur: number;
    binanceUsdt: number;
    bcvValueDate?: string;
  }): Promise<ExchangeApiResponse> {
    const valueDateStr = params.bcvValueDate ?? getCaracasWallDate();
    const valueDate = new Date(`${valueDateStr}T00:00:00Z`);

    await prisma.exchangeRate.create({
      data: {
        bcvUsd: params.bcvUsd,
        bcvEur: params.bcvEur,
        binanceUsdt: params.binanceUsdt,
        bcvUsdSource: 'manual_override',
        bcvEurSource: 'manual_override',
        usdtSource: 'manual_override',
        bcvValueDate: valueDate,
        source: 'manual',
        isManualOverride: true,
      },
    });

    try {
      await redis.del('exchange:latest');
    } catch {
      // Ignore
    }

    return this.getLatestEffectiveRates();
  }

  async bumpCatalogCache(): Promise<void> {
    try {
      await redis.incr('catalog:version');
    } catch {
      // Ignore
    }
  }
}

export const ratesService = new RatesService();
