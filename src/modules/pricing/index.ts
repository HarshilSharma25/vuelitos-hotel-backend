import { Rational } from './money.js';
import {
  Currency,
  FxRates,
  HotelPaymentRuleInput,
  MethodTotal,
  Money,
  PriceFailure,
  SeasonInput,
} from './types.js';
import {
  parseStayWindow,
  resolveSingleRoomStay,
  SingleRoomPriceResult,
  StayWindow,
} from './season.js';
import { calculateMoneyFromBase, calculateRoomBase } from './calculate.js';
import { priceByPaymentMethod } from './payment-methods.js';

import { env } from '../../config/env.js';

export * from './money.js';
export * from './types.js';
export * from './split.js';
export * from './pick-rate.js';
export * from './season.js';
export * from './calculate.js';
export * from './payment-methods.js';

export interface RoomSelectionInput {
  roomTypeId: string;
  adults: number;
  children: number;
  childAges: number[];
}

export interface PriceStayOptions {
  checkIn: string;
  checkOut: string;
  mealPlan: string;
  roomSelections: RoomSelectionInput[];
  baseCurrency: Currency;
  isSoloDivisas: boolean;
  childBandsEnabled?: boolean;
  seasons: SeasonInput[];
  paymentRules: HotelPaymentRuleInput[];
  fx: FxRates;
  bookingDate: string;
}

export interface PricedRoomOutput {
  roomTypeId: string;
  guests: number;
  price: Money;
  baseRational: Rational;
}

export type PriceStayResult =
  | {
      priced: true;
      nights: number;
      baseCurrency: Currency;
      rooms: PricedRoomOutput[];
      total: Money;
      totalBase: Rational;
      methods: MethodTotal[];
      exchange: FxRates;
    }
  | {
      priced: false;
      reason: PriceFailure;
      minNightsRequired?: number;
    };

export function priceStay(opts: PriceStayOptions): PriceStayResult {
  const window = parseStayWindow(opts.checkIn, opts.checkOut);
  if (!window) {
    return { priced: false, reason: 'no_season' };
  }

  if (opts.roomSelections.length === 0) {
    return { priced: false, reason: 'no_rate' };
  }

  const roomOutputs: PricedRoomOutput[] = [];
  let totalBaseRat = new Rational(0n, 1n);

  for (const selection of opts.roomSelections) {
    const useChildBands = Boolean(
      env.PRICING_CHILD_BANDS && opts.childBandsEnabled && selection.children > 0
    );
    const effectiveAdultGuests = useChildBands
      ? selection.adults
      : selection.adults + selection.children;
    const guests = selection.adults + selection.children;

    const res: SingleRoomPriceResult = resolveSingleRoomStay(
      opts.seasons,
      selection.roomTypeId,
      opts.mealPlan,
      window,
      effectiveAdultGuests,
      opts.bookingDate
    );

    if (!res.priced) {
      return {
        priced: false,
        reason: res.reason,
        minNightsRequired: res.minNightsRequired,
      };
    }

    let roomBaseRat = calculateRoomBase(res.runs, effectiveAdultGuests);

    if (useChildBands) {
      const activeSeasons = opts.seasons.filter((s) => {
        if (!s.isActive) return false;
        if (s.bookingFrom && opts.bookingDate < s.bookingFrom) return false;
        if (s.bookingTo && opts.bookingDate > s.bookingTo) return false;
        return true;
      });
      activeSeasons.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (b.dateFrom !== a.dateFrom) return b.dateFrom.localeCompare(a.dateFrom);
        return a.id.localeCompare(b.id);
      });

      for (let i = 0; i < window.nights; i++) {
        const nightDate = window.dates[i];
        const nightStr = window.dateStrings[i];
        const coveringSeason = activeSeasons.find(
          (s) => s.dateFrom <= nightStr && nightStr <= s.dateTo
        );
        if (!coveringSeason) continue;

        const adultRun = res.runs[0];
        const adultNet = adultRun ? Rational.from(adultRun.rate.netRate) : new Rational(0n, 1n);
        const adultUnit =
          adultRun && adultRun.rate.pricingUnit === 'per_person'
            ? adultNet
            : adultNet.div(Rational.from(Math.max(1, selection.adults)));

        for (const age of selection.childAges) {
          const childRate = coveringSeason.rates.find((r) => {
            if (!r.isActive || r.roomTypeId !== selection.roomTypeId || r.mealPlan !== opts.mealPlan) {
              return false;
            }
            if (r.concept !== 'NINO') return false;
            if (r.childAgeMin !== null && r.childAgeMin !== undefined && age < r.childAgeMin) return false;
            if (r.childAgeMax !== null && r.childAgeMax !== undefined && age > r.childAgeMax) return false;
            return true;
          });

          if (childRate) {
            if (childRate.priceKind === 'GRATIS') {
            } else if (childRate.priceKind === 'PORCENTAJE_ADULTO' && childRate.percentOfAdult) {
              const pct = Rational.from(childRate.percentOfAdult).div(Rational.from(100));
              roomBaseRat = roomBaseRat.add(adultUnit.mul(pct));
            } else {
              roomBaseRat = roomBaseRat.add(Rational.from(childRate.netRate));
            }
          } else {
            const paxRate = coveringSeason.rates.find(
              (r) =>
                r.isActive &&
                r.roomTypeId === selection.roomTypeId &&
                r.mealPlan === opts.mealPlan &&
                r.concept === 'PAX_ADICIONAL'
            );
            if (paxRate) {
              roomBaseRat = roomBaseRat.add(Rational.from(paxRate.netRate));
            } else if (adultRun && adultRun.rate.pricingUnit === 'per_person') {
              roomBaseRat = roomBaseRat.add(adultUnit);
            }
          }
        }
      }
    }
    totalBaseRat = totalBaseRat.add(roomBaseRat);

    const roomMoney = calculateMoneyFromBase(
      roomBaseRat,
      opts.baseCurrency,
      opts.isSoloDivisas,
      opts.fx
    );

    roomOutputs.push({
      roomTypeId: selection.roomTypeId,
      guests,
      price: roomMoney,
      baseRational: roomBaseRat,
    });
  }

  const totalMoney = calculateMoneyFromBase(
    totalBaseRat,
    opts.baseCurrency,
    opts.isSoloDivisas,
    opts.fx
  );

  const methods = priceByPaymentMethod(
    totalBaseRat,
    opts.baseCurrency,
    opts.isSoloDivisas,
    opts.paymentRules,
    opts.fx
  );

  return {
    priced: true,
    nights: window.nights,
    baseCurrency: opts.baseCurrency,
    rooms: roomOutputs,
    total: totalMoney,
    totalBase: totalBaseRat,
    methods,
    exchange: opts.fx,
  };
}
