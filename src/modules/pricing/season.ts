import { pickRate } from './pick-rate.js';
import { PriceFailure, RateInput, SeasonInput } from './types.js';

export interface StayWindow {
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  nights: number;
  dates: Date[]; // 00:00:00Z on each night
  dateStrings: string[];
}

export function parseStayWindow(checkIn: string, checkOut: string): StayWindow | null {
  const dIn = new Date(`${checkIn}T00:00:00Z`);
  const dOut = new Date(`${checkOut}T00:00:00Z`);
  if (isNaN(dIn.getTime()) || isNaN(dOut.getTime())) return null;

  const diffMs = dOut.getTime() - dIn.getTime();
  const nights = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (nights < 1 || nights > 60) return null;

  const dates: Date[] = [];
  const dateStrings: string[] = [];
  for (let i = 0; i < nights; i++) {
    const cur = new Date(dIn.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(cur);
    dateStrings.push(cur.toISOString().slice(0, 10));
  }

  return { checkIn, checkOut, nights, dates, dateStrings };
}

export interface PricedNightSuccess {
  date: Date;
  dateString: string;
  seasonId: string;
  rate: RateInput;
}

export interface PricedNightFailure {
  date: Date;
  dateString: string;
  reason: PriceFailure;
  minNightsRequired?: number;
}

export interface RateRun {
  rate: RateInput;
  nightsCount: number;
}

export interface SingleRoomPriceSuccess {
  priced: true;
  runs: RateRun[];
  totalNights: number;
}

export interface SingleRoomPriceFailure {
  priced: false;
  reason: PriceFailure;
  minNightsRequired?: number;
}

export type SingleRoomPriceResult = SingleRoomPriceSuccess | SingleRoomPriceFailure;

export function resolveSingleRoomStay(
  seasons: SeasonInput[],
  roomTypeId: string,
  mealPlan: string,
  window: StayWindow,
  guests: number,
  bookingDate: string // YYYY-MM-DD
): SingleRoomPriceResult {
  // 1. Filter out seasons whose booking window is closed on the booking date
  const activeSeasons = seasons.filter((s) => {
    if (!s.isActive) return false;
    if (s.bookingFrom && bookingDate < s.bookingFrom) return false;
    if (s.bookingTo && bookingDate > s.bookingTo) return false;
    return true;
  });

  // 2. Order by priority desc, later dateFrom, then id
  activeSeasons.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.dateFrom !== a.dateFrom) return b.dateFrom.localeCompare(a.dateFrom);
    return a.id.localeCompare(b.id);
  });

  const pricedNights: PricedNightSuccess[] = [];
  let worstFailure: PricedNightFailure | null = null;

  for (let i = 0; i < window.nights; i++) {
    const nightDate = window.dates[i];
    const nightStr = window.dateStrings[i];

    // Covering seasons: dateFrom <= nightStr <= dateTo
    const coveringSeasons = activeSeasons.filter(
      (s) => s.dateFrom <= nightStr && nightStr <= s.dateTo
    );

    if (coveringSeasons.length === 0) {
      return { priced: false, reason: 'no_season' };
    }

    let nightFound: PricedNightSuccess | null = null;
    let minNightsReq: number | undefined;
    let hadRatesButMinNights = false;

    for (const season of coveringSeasons) {
      const candidates = season.rates.filter(
        (r) => r.roomTypeId === roomTypeId && r.mealPlan === mealPlan && r.isActive
      );
      if (candidates.length === 0) continue;

      const pick = pickRate(candidates, nightDate, guests, window.nights);
      if ('rate' in pick) {
        nightFound = {
          date: nightDate,
          dateString: nightStr,
          seasonId: season.id,
          rate: pick.rate,
        };
        break; // First covering season with an applicable rate wins
      } else if (pick.error === 'min_nights') {
        hadRatesButMinNights = true;
        if (pick.required !== undefined) {
          minNightsReq = minNightsReq === undefined ? pick.required : Math.min(minNightsReq, pick.required);
        }
      }
    }

    if (!nightFound) {
      if (hadRatesButMinNights) {
        worstFailure = {
          date: nightDate,
          dateString: nightStr,
          reason: 'min_nights',
          minNightsRequired: minNightsReq,
        };
      } else {
        worstFailure = {
          date: nightDate,
          dateString: nightStr,
          reason: 'no_rate',
        };
      }
      break;
    }

    pricedNights.push(nightFound);
  }

  if (worstFailure || pricedNights.length !== window.nights) {
    return {
      priced: false,
      reason: worstFailure?.reason ?? 'no_rate',
      minNightsRequired: worstFailure?.minNightsRequired,
    };
  }

  // 3. Regroup consecutive nights on the same rate row
  const runs: RateRun[] = [];
  for (const pn of pricedNights) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.rate.id === pn.rate.id) {
      lastRun.nightsCount++;
    } else {
      runs.push({ rate: pn.rate, nightsCount: 1 });
    }
  }

  return { priced: true, runs, totalNights: window.nights };
}
