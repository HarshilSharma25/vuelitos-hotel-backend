import { Rational } from './money.js';
import { Currency, FxRates, Money } from './types.js';
import { RateRun } from './season.js';

export function calculateRoomBase(
  runs: RateRun[],
  guests: number
): Rational {
  let totalBase = new Rational(0n, 1n);

  for (const run of runs) {
    const netRate = Rational.from(run.rate.netRate);
    const nights = BigInt(run.nightsCount);
    const multiplier = run.rate.pricingUnit === 'per_room' ? 1n : BigInt(guests);

    const runBase = netRate.mul(nights).mul(multiplier);
    totalBase = totalBase.add(runBase);
  }

  return totalBase;
}

export function calculateMoneyFromBase(
  base: Rational,
  baseCurrency: Currency,
  isSoloDivisas: boolean,
  fx: FxRates,
  ivaRateBs: number = 0.16
): Money {
  const baseRounded = base.toDecimal(2);

  if (isSoloDivisas) {
    return {
      base: baseRounded,
      bs: null,
      usdt: baseRounded,
    };
  }

  const bcvUsd = fx.bcvUsd ?? fx.bcv_usd ?? null;
  const bcvEur = fx.bcvEur ?? fx.bcv_eur ?? null;
  const binanceUsdt = fx.binanceUsdt ?? fx.binance_usdt ?? null;

  const bcv = baseCurrency === 'USD' ? bcvUsd : bcvEur;
  if (!bcv || !binanceUsdt) {
    return {
      base: baseRounded,
      bs: null,
      usdt: baseRounded,
    };
  }

  const bcvRat = Rational.from(bcv);
  const ivaRat = Rational.from(1).add(Rational.from(ivaRateBs));
  const binanceRat = Rational.from(binanceUsdt);

  // bs = base * BCV(base) * (1 + iva_bs)
  const bsRat = base.mul(bcvRat).mul(ivaRat);
  // usdt = bs / binance_usdt
  const usdtRat = bsRat.div(binanceRat);

  return {
    base: baseRounded,
    bs: bsRat.toDecimal(2),
    usdt: usdtRat.toDecimal(2),
  };
}
