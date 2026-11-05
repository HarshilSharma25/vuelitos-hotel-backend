import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { BcvRateResult } from './sources/bcv.js';

export interface ComposeInput {
  freshBcv?: BcvRateResult | null;
  freshUsdt?: number | null;
}

export interface ComposeResult {
  inserted: boolean;
  bcvPublishedUpserted: boolean;
  rateId?: string;
  bcvUsd: number;
  bcvEur: number;
  binanceUsdt: number;
  bcvValueDate: string;
}

const RATES_LOCK_NAME = 'hotel_rates_compose';

export async function composeAndPersistRates(input: ComposeInput): Promise<ComposeResult> {
  const { freshBcv, freshUsdt } = input;

  if (!freshBcv && !freshUsdt) {
    throw new Error('Both fresh BCV and fresh USDT sources failed; cannot compose rates.');
  }

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ got: bigint | number | null }>>`
      SELECT GET_LOCK(${RATES_LOCK_NAME}, 10) AS got
    `;
    if (Number(locked[0]?.got) !== 1) {
      throw new Error('Could not acquire rates compose lock');
    }

    try {
      return await persistComposedRates(tx, freshBcv, freshUsdt);
    } finally {
      await tx.$executeRaw`SELECT RELEASE_LOCK(${RATES_LOCK_NAME})`;
    }
  }, { timeout: 20000 });
}

async function persistComposedRates(
  tx: Prisma.TransactionClient,
  freshBcv: BcvRateResult | null | undefined,
  freshUsdt: number | null | undefined
): Promise<ComposeResult> {

    let bcvUpserted = false;
    if (freshBcv) {
      const vDate = new Date(`${freshBcv.valueDate}T00:00:00Z`);
      await tx.bcvPublishedRate.upsert({
        where: { valueDate: vDate },
        create: {
          valueDate: vDate,
          usd: freshBcv.usd,
          eur: freshBcv.eur,
          publishedAt: new Date(),
        },
        update: {
          usd: freshBcv.usd,
          eur: freshBcv.eur,
          publishedAt: new Date(),
        },
      });
      bcvUpserted = true;
    }

    const lastRow = await tx.exchangeRate.findFirst({
      where: { isManualOverride: false },
      orderBy: { recordedAt: 'desc' },
    });

    if (!lastRow && (!freshBcv || !freshUsdt)) {
      throw new Error('No prior exchange rate available to carry forward missing values.');
    }

    let bcvUsd: number;
    let bcvEur: number;
    let bcvUsdSource: string;
    let bcvEurSource: string;
    let bcvValueDate: Date;

    if (freshBcv) {
      bcvUsd = freshBcv.usd;
      bcvEur = freshBcv.eur;
      bcvUsdSource = 'bcv_scraper';
      bcvEurSource = 'bcv_scraper';
      bcvValueDate = new Date(`${freshBcv.valueDate}T00:00:00Z`);
    } else {
      bcvUsd = Number(lastRow!.bcvUsd);
      bcvEur = Number(lastRow!.bcvEur);
      bcvUsdSource = lastRow!.bcvUsdSource.startsWith('carried:')
        ? lastRow!.bcvUsdSource
        : `carried:${lastRow!.bcvUsdSource}`;
      bcvEurSource = lastRow!.bcvEurSource.startsWith('carried:')
        ? lastRow!.bcvEurSource
        : `carried:${lastRow!.bcvEurSource}`;
      bcvValueDate = lastRow!.bcvValueDate;
      logger.info({ bcvUsdSource, bcvEurSource }, '[RatesCompose] BCV missing, carrying forward');
    }

    let binanceUsdt: number;
    let usdtSource: string;

    if (freshUsdt !== undefined && freshUsdt !== null) {
      binanceUsdt = freshUsdt;
      usdtSource = 'binance_p2p';
    } else {
      binanceUsdt = Number(lastRow!.binanceUsdt);
      usdtSource = lastRow!.usdtSource.startsWith('carried:')
        ? lastRow!.usdtSource
        : `carried:${lastRow!.usdtSource}`;
      logger.info({ usdtSource }, '[RatesCompose] USDT missing, carrying forward');
    }

    let shouldInsert = false;
    if (!lastRow) {
      shouldInsert = true;
    } else {
      const bcvChanged =
        freshBcv !== null &&
        freshBcv !== undefined &&
        (Number(lastRow.bcvUsd) !== bcvUsd ||
          Number(lastRow.bcvEur) !== bcvEur ||
          lastRow.bcvValueDate.toISOString().slice(0, 10) !== freshBcv.valueDate);

      const usdtIsFresh = freshUsdt !== null && freshUsdt !== undefined;
      shouldInsert = bcvChanged || usdtIsFresh;
    }

    let createdId: string | undefined;

    if (shouldInsert) {
      const created = await tx.exchangeRate.create({
        data: {
          bcvUsd,
          bcvEur,
          binanceUsdt,
          bcvUsdSource,
          bcvEurSource,
          usdtSource,
          recordedAt: new Date(),
          fetchedAt: new Date(),
          bcvValueDate,
          source: 'auto',
          isManualOverride: false,
        },
      });
      createdId = created.id.toString();

      try {
        await redis.del('exchange:latest');
        await redis.incr('catalog:version');
      } catch {}
    }

    return {
      inserted: shouldInsert,
      bcvPublishedUpserted: bcvUpserted,
      rateId: createdId,
      bcvUsd,
      bcvEur,
      binanceUsdt,
      bcvValueDate: bcvValueDate.toISOString().slice(0, 10),
    };
}
