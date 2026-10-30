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
  seasons: SeasonInput[];
  paymentRules: HotelPaymentRuleInput[];
  fx: FxRates;
  bookingDate: string; // Caracas wall date (YYYY-MM-DD)
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
    const guests = selection.adults + selection.children;
    const res: SingleRoomPriceResult = resolveSingleRoomStay(
      opts.seasons,
      selection.roomTypeId,
      opts.mealPlan,
      window,
      guests,
      opts.bookingDate
    );

    if (!res.priced) {
      return {
        priced: false,
        reason: res.reason,
        minNightsRequired: res.minNightsRequired,
      };
    }

    const roomBaseRat = calculateRoomBase(res.runs, guests);
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
