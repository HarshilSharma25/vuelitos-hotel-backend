import { Rational } from './money.js';
import {
  Currency,
  FxRates,
  HotelPaymentRuleInput,
  MethodTotal,
  PayCurrency,
  PaymentMethod,
} from './types.js';

export const METHOD_ORDER: PaymentMethod[] = [
  'stripe_card',
  'pago_movil',
  'bs_transfer',
  'zelle',
  'usdt_binance',
  'cash_usd',
  'cash_eur',
];

export function priceByPaymentMethod(
  base: Rational,
  baseCurrency: Currency,
  isSoloDivisas: boolean,
  rules: HotelPaymentRuleInput[],
  fx: FxRates
): MethodTotal[] {
  const ruleMap = new Map<PaymentMethod, HotelPaymentRuleInput>();
  for (const r of rules) {
    ruleMap.set(r.method, r);
  }

  // Find iva rate for pago_movil/bs if available, default 0.16
  const pmRule = ruleMap.get('pago_movil');
  const ivaPagoMovil = pmRule?.ivaRate ?? 0.16;

  const bcvUsd = fx.bcvUsd ?? fx.bcv_usd ?? null;
  const bcvEur = fx.bcvEur ?? fx.bcv_eur ?? null;
  const binanceUsdt = fx.binanceUsdt ?? fx.binance_usdt ?? null;

  const rows: {
    method: PaymentMethod;
    currency: PayCurrency;
    amountRat: Rational;
    ivaRate: number;
    ivaAmountRat: Rational;
    exchangeRateUsed: number | null;
    usdEquiv: Rational;
  }[] = [];

  for (const method of METHOD_ORDER) {
    const rule = ruleMap.get(method);
    if (!rule) continue;

    // Solo-divisas hotels get no VES rows
    if (isSoloDivisas && (method === 'pago_movil' || method === 'bs_transfer')) {
      continue;
    }

    const ivaRate = rule.ivaRate;
    const ivaRat = Rational.from(1).add(Rational.from(ivaRate));
    const ivaOnlyRat = Rational.from(ivaRate);

    if (method === 'pago_movil' || method === 'bs_transfer') {
      const bcv = baseCurrency === 'USD' ? bcvUsd : bcvEur;
      if (!bcv) continue;
      const bcvRat = Rational.fromNumber(bcv);

      // base x BCV(base), then x (1 + iva)
      const preIva = base.mul(bcvRat);
      const amountRat = preIva.mul(ivaRat);
      const ivaAmountRat = preIva.mul(ivaOnlyRat);

      // USD equivalent: divide amount by bcvUsd
      const bcvUsdRat = Rational.fromNumber(bcvUsd ?? bcv);
      const usdEquiv = amountRat.div(bcvUsdRat);

      rows.push({
        method,
        currency: 'VES',
        amountRat,
        ivaRate,
        ivaAmountRat,
        exchangeRateUsed: bcv,
        usdEquiv,
      });
    } else if (method === 'zelle' || method === 'cash_usd') {
      let targetBase = base;
      let exchUsed: number | null = null;
      if (baseCurrency === 'EUR') {
        if (!bcvEur || !bcvUsd) continue;
        // base x BCV(base) / BCV(target)
        exchUsed = bcvEur / bcvUsd;
        targetBase = base.mul(Rational.fromNumber(bcvEur)).div(Rational.fromNumber(bcvUsd));
      }

      const amountRat = targetBase.mul(ivaRat);
      const ivaAmountRat = targetBase.mul(ivaOnlyRat);

      rows.push({
        method,
        currency: 'USD',
        amountRat,
        ivaRate,
        ivaAmountRat,
        exchangeRateUsed: exchUsed,
        usdEquiv: amountRat,
      });
    } else if (method === 'cash_eur') {
      let targetBase = base;
      let exchUsed: number | null = null;
      if (baseCurrency === 'USD') {
        if (!bcvEur || !bcvUsd) continue;
        // base x BCV(base) / BCV(target)
        exchUsed = bcvUsd / bcvEur;
        targetBase = base.mul(Rational.fromNumber(bcvUsd)).div(Rational.fromNumber(bcvEur));
      }

      const amountRat = targetBase.mul(ivaRat);
      const ivaAmountRat = targetBase.mul(ivaOnlyRat);

      // USD equiv for EUR: amount * bcvEur / bcvUsd
      const usdEquiv = bcvEur && bcvUsd
        ? amountRat.mul(Rational.fromNumber(bcvEur)).div(Rational.fromNumber(bcvUsd))
        : amountRat;

      rows.push({
        method,
        currency: 'EUR',
        amountRat,
        ivaRate,
        ivaAmountRat,
        exchangeRateUsed: exchUsed,
        usdEquiv,
      });
    } else if (method === 'stripe_card') {
      let targetBase = base;
      let exchUsed: number | null = null;
      if (baseCurrency === 'EUR') {
        if (!bcvEur || !bcvUsd) continue;
        exchUsed = bcvEur / bcvUsd;
        targetBase = base.mul(Rational.fromNumber(bcvEur)).div(Rational.fromNumber(bcvUsd));
      }

      const surcharge = rule.surchargePercent ?? 0;
      const surchargeRat = Rational.from(1).add(Rational.from(surcharge).div(Rational.from(100)));
      const preIva = targetBase.mul(surchargeRat);
      const amountRat = preIva.mul(ivaRat);
      const ivaAmountRat = preIva.mul(ivaOnlyRat);

      rows.push({
        method,
        currency: 'USD',
        amountRat,
        ivaRate,
        ivaAmountRat,
        exchangeRateUsed: exchUsed,
        usdEquiv: amountRat,
      });
    } else if (method === 'usdt_binance') {
      if (isSoloDivisas) {
        // Solo-divisas: base 1:1, no bs, no iva
        rows.push({
          method,
          currency: 'USDT',
          amountRat: base,
          ivaRate: 0,
          ivaAmountRat: new Rational(0n, 1n),
          exchangeRateUsed: 1,
          usdEquiv: base,
        });
      } else {
        const bcv = baseCurrency === 'USD' ? bcvUsd : bcvEur;
        if (!bcv || !binanceUsdt) continue;

        // base x BCV(base) x (1 + iva_pago_movil) / binance
        const bcvRat = Rational.from(bcv);
        const ivaRatPM = Rational.from(1).add(Rational.from(ivaPagoMovil));
        const binanceRat = Rational.from(binanceUsdt);

        const amountRat = base.mul(bcvRat).mul(ivaRatPM).div(binanceRat);

        rows.push({
          method,
          currency: 'USDT',
          amountRat,
          ivaRate: ivaPagoMovil,
          ivaAmountRat: base.mul(bcvRat).mul(Rational.fromNumber(ivaPagoMovil)).div(binanceRat),
          exchangeRateUsed: binanceUsdt,
          usdEquiv: amountRat,
        });
      }
    }
  }

  // Find lowest USD equivalent
  let minUsdRat: Rational | null = null;
  for (const r of rows) {
    if (minUsdRat === null || r.usdEquiv.cmp(minUsdRat) < 0) {
      minUsdRat = r.usdEquiv;
    }
  }

  return rows.map((r) => {
    const isLowest = minUsdRat !== null && r.usdEquiv.cmp(minUsdRat) === 0;
    return {
      method: r.method,
      currency: r.currency,
      amount: r.amountRat.toDecimal(2),
      iva_rate: r.ivaRate,
      iva_amount: r.ivaAmountRat.toDecimal(2),
      exchange_rate_used: r.exchangeRateUsed !== null ? Number(r.exchangeRateUsed.toFixed(4)) : null,
      is_lowest: isLowest,
    };
  });
}
