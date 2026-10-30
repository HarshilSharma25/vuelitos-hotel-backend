import { Rational } from './money.js';

export type Currency = 'USD' | 'EUR';
export type PayCurrency = 'VES' | 'USD' | 'EUR' | 'USDT';
export type PaymentMethod =
  | 'stripe_card'
  | 'pago_movil'
  | 'bs_transfer'
  | 'zelle'
  | 'usdt_binance'
  | 'cash_usd'
  | 'cash_eur';

export type RateConcept = 'OCUPACION' | 'NINO' | 'PAX_ADICIONAL';
export type PriceKind = 'IMPORTE' | 'BAJO_PEDIDO' | 'GRATIS' | 'PORCENTAJE_ADULTO';
export type PricingUnit = 'per_room' | 'per_person';

export interface RateInput {
  id: string;
  roomTypeId: string;
  seasonId: string;
  mealPlan: string;
  concept: RateConcept | null;
  priceKind: PriceKind;
  occupancy: number | null;
  pricingUnit: PricingUnit;
  netRate: number | string | Rational;
  daysOfWeek: number[];
  minNights: number;
  maxNights: number | null;
  isActive: boolean;
}

export interface SeasonInput {
  id: string;
  hotelId: string;
  name: string;
  priority: number;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;   // YYYY-MM-DD (inclusive of last covered night)
  bookingFrom: string | null;
  bookingTo: string | null;
  isActive: boolean;
  rates: RateInput[];
}

export interface FxRates {
  bcvUsd?: number | null;
  bcvEur?: number | null;
  binanceUsdt?: number | null;
  bcv_usd?: number | null;
  bcv_eur?: number | null;
  binance_usdt?: number | null;
  bcvValueDate?: string | null;
  bcv_value_date?: string | null;
  stale: boolean;
}

export interface HotelPaymentRuleInput {
  method: PaymentMethod;
  ivaRate: number;
  surchargePercent?: number | null;
}

export interface Money {
  base: number;
  bs: number | null;
  usdt: number;
}

export interface MethodTotal {
  method: PaymentMethod;
  currency: PayCurrency;
  amount: number;
  iva_rate: number;
  iva_amount: number;
  exchange_rate_used: number | null;
  is_lowest: boolean;
}

export type PriceFailure = 'no_season' | 'no_rate' | 'min_nights';

export interface PickRateSuccess {
  rate: RateInput;
}

export interface PickRateFailure {
  error: 'no_rate' | 'min_nights';
  required?: number;
}

export type PickRateResult = PickRateSuccess | PickRateFailure;
