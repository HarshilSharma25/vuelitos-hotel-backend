import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { ratesService } from '../rates/service.js';
import {
  effectiveRooms,
  parseStayWindow,
  priceStay,
  Rational,
  splitGuests,
  calculateMoneyFromBase,
  RateInput,
  SeasonInput,
  FxRates,
} from '../pricing/index.js';
import { getCaracasWallDate } from '../../lib/caracas-time.js';
import {
  InvalidStayWindowError,
  NotFoundError,
} from '../../lib/errors.js';

export interface CatalogSearchParams {
  destination?: string;
  check_in?: string;
  check_out?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  meal_plan?: string;
  max_price?: number;
  category?: string;
  q?: string;
  sort?: 'price_asc' | 'price_desc' | 'stars_desc';
  cursor?: string;
  limit?: number;
}

export function calculateUndatedDesde(
  hotelRooms: { id: string; maxOccupancy: number }[],
  pureSeasons: SeasonInput[],
  mealPlans: string[],
  filterMealPlan: string | undefined,
  roomsQuoted: number,
  totalGuests: number,
  baseCurrency: any,
  isSoloDivisas: boolean,
  fx: any
): { price: any; availability: 'ok' | 'no_rate' } {
  const split = splitGuests(totalGuests, roomsQuoted);
  const biggestInRoom = Math.max(...split, 1);
  let bestUsdt = Infinity;
  let bestBase = Infinity;
  let bestMoney: any = null;

  for (const room of hotelRooms) {
    if (room.maxOccupancy < biggestInRoom) continue;

    for (const mp of mealPlans) {
      if (filterMealPlan && mp !== filterMealPlan) continue;

      let roomTotalRat = new Rational(0n, 1n);
      let canPriceAll = true;

      for (const guestsInRoom of split) {
        let bestRateForGuestRat: Rational | null = null;

        for (const s of pureSeasons) {
          if (!s.isActive) continue;
          for (const r of s.rates) {
            if (!r.isActive || r.roomTypeId !== room.id || r.mealPlan !== mp || r.priceKind !== 'IMPORTE') continue;
            if (r.concept !== 'OCUPACION' && r.concept !== null) continue;
            if (r.occupancy !== null && r.occupancy !== guestsInRoom) continue;
            if (r.minNights > 1) continue;

            const rateRat = Rational.from(r.netRate);
            const mult = r.pricingUnit === 'per_room' ? 1n : BigInt(guestsInRoom);
            const rateBaseRat = rateRat.mul(mult);

            if (bestRateForGuestRat === null || rateBaseRat.cmp(bestRateForGuestRat) < 0) {
              bestRateForGuestRat = rateBaseRat;
            }
          }
        }

        if (!bestRateForGuestRat) {
          canPriceAll = false;
          break;
        }
        roomTotalRat = roomTotalRat.add(bestRateForGuestRat);
      }

      if (canPriceAll) {
        const money = calculateMoneyFromBase(roomTotalRat, baseCurrency, isSoloDivisas, fx);
        // Rank by USDT, then base
        if (money.usdt < bestUsdt || (money.usdt === bestUsdt && money.base < bestBase)) {
          bestUsdt = money.usdt;
          bestBase = money.base;
          bestMoney = money;
        }
      }
    }
  }

  if (bestMoney) {
    return { price: bestMoney, availability: 'ok' };
  }
  return { price: null, availability: 'no_rate' };
}

export class CatalogService {
  async getDestinations() {
    const hotels = await prisma.hotel.findMany({
      where: { isActive: true },
      select: { destination: true },
    });

    const destMap = new Map<string, { slug: string; name: string; hotel_count: number }>();
    for (const h of hotels) {
      const slug = h.destination.toLowerCase().replace(/\s+/g, '-');
      const existing = destMap.get(slug);
      if (existing) {
        existing.hotel_count++;
      } else {
        destMap.set(slug, {
          slug,
          name: h.destination,
          hotel_count: 1,
        });
      }
    }

    return { destinations: Array.from(destMap.values()) };
  }

  async searchHotels(params: CatalogSearchParams) {
    // 1. Clamp applied params
    const adults = Math.min(20, Math.max(1, Number(params.adults) || 2));
    const children = Math.min(20, Math.max(0, Number(params.children) || 0));
    const rooms = Math.min(10, Math.max(1, Number(params.rooms) || 1));
    const limit = Math.min(50, Math.max(1, Number(params.limit) || 20));
    const totalGuests = adults + children;

    const hasDates = Boolean(params.check_in && params.check_out);
    let stayWindow = null;
    if (hasDates) {
      stayWindow = parseStayWindow(params.check_in!, params.check_out!);
    }

    const fx = await ratesService.getLatestEffectiveRates();
    const bookingDate = env.PRICING_NOW || getCaracasWallDate();

    // 2. Query hotels from DB
    const whereClause: any = { isActive: true };
    if (params.destination) {
      whereClause.destination = {
        contains: params.destination.replace(/-/g, ' '),
        mode: 'insensitive',
      };
    }
    if (params.category) {
      whereClause.category = { equals: params.category, mode: 'insensitive' };
    }
    if (params.q) {
      whereClause.name = { contains: params.q, mode: 'insensitive' };
    }

    const hotels = await prisma.hotel.findMany({
      where: whereClause,
      include: {
        rooms: { where: { isActive: true } },
        seasons: {
          where: { isActive: true },
          include: { rates: { where: { isActive: true } } },
        },
        paymentRules: true,
        images: { where: { status: 'published' }, orderBy: { sortOrder: 'asc' } },
      },
    });

    const items: any[] = [];

    for (const h of hotels) {
      if (h.rooms.length === 0) continue;

      const maxOcc = Math.max(...h.rooms.map((r) => r.maxOccupancy), 1);
      const roomsQuoted = effectiveRooms(rooms, totalGuests, maxOcc);

      const mealPlansSet = new Set<string>();
      h.seasons.forEach((s) => s.rates.forEach((r) => mealPlansSet.add(r.mealPlan)));
      const mealPlans = Array.from(mealPlansSet);

      if (params.meal_plan && !mealPlans.includes(params.meal_plan)) {
        continue;
      }

      const firstImage = h.images[0];
      const fallbackImageUrl = firstImage
        ? `${env.FILES_PUBLIC_BASE_URL}/${firstImage.key.replace(/^private\//, 'public/')}`
        : null;
      let resolvedCoverUrl = h.coverImageUrl;
      if (!resolvedCoverUrl && h.coverImageKey) {
        resolvedCoverUrl = h.coverImageKey.startsWith('http://') || h.coverImageKey.startsWith('https://')
          ? h.coverImageKey
          : `${env.FILES_PUBLIC_BASE_URL}/${h.coverImageKey.replace(/^private\//, 'public/')}`;
      }
      const imageUrl = resolvedCoverUrl || fallbackImageUrl;

      // Transform seasons to pure SeasonInput
      const pureSeasons: SeasonInput[] = h.seasons.map((s) => ({
        id: s.id,
        hotelId: s.hotelId,
        name: s.name,
        priority: s.priority,
        dateFrom: s.dateFrom.toISOString().slice(0, 10),
        dateTo: s.dateTo.toISOString().slice(0, 10),
        bookingFrom: s.bookingFrom ? s.bookingFrom.toISOString().slice(0, 10) : null,
        bookingTo: s.bookingTo ? s.bookingTo.toISOString().slice(0, 10) : null,
        isActive: s.isActive,
        rates: s.rates.map((r) => ({
          id: r.id,
          roomTypeId: r.roomTypeId,
          seasonId: r.seasonId,
          mealPlan: r.mealPlan,
          concept: r.concept as any,
          priceKind: r.priceKind as any,
          occupancy: r.occupancy,
          pricingUnit: r.pricingUnit as any,
          netRate: r.netRate.toString(),
          daysOfWeek: r.daysOfWeek,
          minNights: r.minNights,
          maxNights: r.maxNights,
          isActive: r.isActive,
        })),
      }));

      const purePaymentRules = h.paymentRules.map((pr) => ({
        method: pr.method as any,
        ivaRate: Number(pr.ivaRate),
        surchargePercent: pr.surchargePercent ? Number(pr.surchargePercent) : null,
      }));

      if (hasDates && stayWindow) {
        // Multi-room split
        const split = splitGuests(totalGuests, roomsQuoted);
        // Find best option across rooms & meal plans
        let bestOptionPrice: any = null;
        let bestUsdt = Infinity;
        let bestAvailability: any = 'no_rate';
        let minNightsReq: number | undefined;

        for (const room of h.rooms) {
          // Check if this room fits the biggest split
          const biggestRoomGuests = Math.max(...split);
          if (room.maxOccupancy < biggestRoomGuests) continue;

          for (const mp of mealPlans) {
            if (params.meal_plan && mp !== params.meal_plan) continue;

            const roomSelections = split.map((guestsInRoom) => ({
              roomTypeId: room.id,
              adults: guestsInRoom,
              children: 0,
              childAges: [],
            }));

            const priced = priceStay({
              checkIn: stayWindow.checkIn,
              checkOut: stayWindow.checkOut,
              mealPlan: mp,
              roomSelections,
              baseCurrency: h.baseCurrency as any,
              isSoloDivisas: h.isSoloDivisas,
              seasons: pureSeasons,
              paymentRules: purePaymentRules,
              fx: fx as any,
              bookingDate,
            });

            if (priced.priced) {
              bestAvailability = 'ok';
              if (priced.total.usdt < bestUsdt) {
                bestUsdt = priced.total.usdt;
                bestOptionPrice = priced.total;
              }
            } else {
              if (bestAvailability !== 'ok') {
                bestAvailability = priced.reason;
                if (priced.minNightsRequired !== undefined) {
                  minNightsReq = priced.minNightsRequired;
                }
              }
            }
          }
        }

        if (params.max_price && bestOptionPrice && bestOptionPrice.usdt > params.max_price) {
          continue;
        }

        items.push({
          slug: h.slug,
          name: h.name,
          destination: h.destination,
          category: h.category,
          star_rating: h.starRating,
          starRating: h.starRating,
          base_currency: h.baseCurrency,
          baseCurrency: h.baseCurrency,
          is_solo_divisas: h.isSoloDivisas,
          isSoloDivisas: h.isSoloDivisas,
          image_url: imageUrl,
          cover_image_url: imageUrl,
          coverImageUrl: imageUrl,
          cover_image_key: h.coverImageKey,
          coverImageKey: h.coverImageKey,
          meal_plans: mealPlans,
          rooms_quoted: roomsQuoted,
          price: bestAvailability === 'ok' ? bestOptionPrice : null,
          price_basis: 'stay_total',
          availability: bestAvailability,
          min_nights_required: bestAvailability === 'min_nights' ? minNightsReq : undefined,
        });
      } else {
        // Undated: find cheapest 1-night room price matching party using splitGuests
        const undatedRes = calculateUndatedDesde(
          h.rooms,
          pureSeasons,
          mealPlans,
          params.meal_plan,
          roomsQuoted,
          totalGuests,
          h.baseCurrency as any,
          h.isSoloDivisas,
          fx
        );

        if (params.max_price && undatedRes.price && undatedRes.price.usdt > params.max_price) {
          continue;
        }

        items.push({
          slug: h.slug,
          name: h.name,
          destination: h.destination,
          category: h.category,
          star_rating: h.starRating,
          starRating: h.starRating,
          base_currency: h.baseCurrency,
          baseCurrency: h.baseCurrency,
          is_solo_divisas: h.isSoloDivisas,
          isSoloDivisas: h.isSoloDivisas,
          image_url: imageUrl,
          cover_image_url: imageUrl,
          coverImageUrl: imageUrl,
          cover_image_key: h.coverImageKey,
          coverImageKey: h.coverImageKey,
          meal_plans: mealPlans,
          rooms_quoted: roomsQuoted,
          price: undatedRes.price,
          price_basis: 'per_night_from',
          availability: undatedRes.availability,
        });
      }
    }

    // Sort items by availability, stars (if requested), then USDT and base
    const sort = params.sort || 'price_asc';
    items.sort((a, b) => {
      // Available items come before unavailable
      const aAvail = a.availability === 'ok' ? 1 : 0;
      const bAvail = b.availability === 'ok' ? 1 : 0;
      if (bAvail !== aAvail) return bAvail - aAvail;

      if (sort === 'stars_desc') {
        const starDiff = (b.star_rating ?? 0) - (a.star_rating ?? 0);
        if (starDiff !== 0) return starDiff;
      }

      const aUsdt = a.price ? a.price.usdt : (sort === 'price_desc' ? -Infinity : Infinity);
      const bUsdt = b.price ? b.price.usdt : (sort === 'price_desc' ? -Infinity : Infinity);
      if (aUsdt !== bUsdt) {
        return sort === 'price_desc' ? bUsdt - aUsdt : aUsdt - bUsdt;
      }

      const aBase = a.price ? a.price.base : (sort === 'price_desc' ? -Infinity : Infinity);
      const bBase = b.price ? b.price.base : (sort === 'price_desc' ? -Infinity : Infinity);
      return sort === 'price_desc' ? bBase - aBase : aBase - bBase;
    });

    // Pagination
    let startIndex = 0;
    if (params.cursor) {
      try {
        const decoded = Buffer.from(params.cursor, 'base64').toString('utf8');
        startIndex = Number(decoded) || 0;
      } catch {
        startIndex = 0;
      }
    }

    const paginatedItems = items.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < items.length
        ? Buffer.from(String(startIndex + limit)).toString('base64')
        : null;

    return {
      data: {
        items: paginatedItems,
        exchange: fx,
      },
      meta: {
        next_cursor: nextCursor,
        applied: {
          check_in: stayWindow ? stayWindow.checkIn : null,
          check_out: stayWindow ? stayWindow.checkOut : null,
          nights: stayWindow ? stayWindow.nights : null,
          adults,
          children,
          rooms,
        },
      },
    };
  }

  async getHotelDetail(slug: string, params: {
    check_in?: string;
    check_out?: string;
    adults?: number;
    children?: number;
    rooms?: number;
  }) {
    const hotel = await prisma.hotel.findUnique({
      where: { slug },
      include: {
        rooms: { where: { isActive: true } },
        seasons: {
          where: { isActive: true },
          include: { rates: { where: { isActive: true } } },
        },
        paymentRules: true,
        images: { where: { status: 'published' }, orderBy: { sortOrder: 'asc' } },
        checks: { orderBy: { checkOut: 'desc' }, take: 1 },
      },
    });

    if (!hotel || !hotel.isActive) {
      throw new NotFoundError(`Hotel with slug '${slug}' not found`);
    }

    const adults = Math.min(20, Math.max(1, Number(params.adults) || 2));
    const children = Math.min(20, Math.max(0, Number(params.children) || 0));
    const rooms = Math.min(10, Math.max(1, Number(params.rooms) || 1));
    const totalGuests = adults + children;

    const maxOcc = Math.max(...hotel.rooms.map((r) => r.maxOccupancy), 1);
    const roomsEffective = effectiveRooms(rooms, totalGuests, maxOcc);

    const isGroup = rooms >= env.GROUP_MIN_ROOMS || totalGuests >= env.GROUP_MIN_GUESTS;
    const groupRequest = isGroup
      ? {
          whatsapp_url: `https://wa.me/584120000000?text=${encodeURIComponent(`Hola, solicito cotizacion grupal para ${hotel.name}: ${rooms} habitaciones, ${totalGuests} personas`)}`,
          email: 'reservas@vuelitos.com',
        }
      : null;

    const fx = await ratesService.getLatestEffectiveRates();
    const bookingDate = env.PRICING_NOW || getCaracasWallDate();

    const pureSeasons: SeasonInput[] = hotel.seasons.map((s) => ({
      id: s.id,
      hotelId: s.hotelId,
      name: s.name,
      priority: s.priority,
      dateFrom: s.dateFrom.toISOString().slice(0, 10),
      dateTo: s.dateTo.toISOString().slice(0, 10),
      bookingFrom: s.bookingFrom ? s.bookingFrom.toISOString().slice(0, 10) : null,
      bookingTo: s.bookingTo ? s.bookingTo.toISOString().slice(0, 10) : null,
      isActive: s.isActive,
      rates: s.rates.map((r) => ({
        id: r.id,
        roomTypeId: r.roomTypeId,
        seasonId: r.seasonId,
        mealPlan: r.mealPlan,
        concept: r.concept as any,
        priceKind: r.priceKind as any,
        occupancy: r.occupancy,
        pricingUnit: r.pricingUnit as any,
        netRate: r.netRate.toString(),
        daysOfWeek: r.daysOfWeek,
        minNights: r.minNights,
        maxNights: r.maxNights,
        isActive: r.isActive,
      })),
    }));

    const purePaymentRules = hotel.paymentRules.map((pr) => ({
      method: pr.method as any,
      ivaRate: Number(pr.ivaRate),
      surchargePercent: pr.surchargePercent ? Number(pr.surchargePercent) : null,
    }));

    const mealPlansSet = new Set<string>();
    hotel.seasons.forEach((s) => s.rates.forEach((r) => mealPlansSet.add(r.mealPlan)));
    const mealPlans = Array.from(mealPlansSet);

    // Build seasonal_rates (one-night list prices)
    const seasonalRates = hotel.seasons.map((s) => ({
      season: s.name,
      date_from: s.dateFrom.toISOString().slice(0, 10),
      date_to: s.dateTo.toISOString().slice(0, 10),
      rows: s.rates
        .filter((r) => r.priceKind === 'IMPORTE')
        .map((r) => {
          const money = calculateMoneyFromBase(
            Rational.from(r.netRate.toString()),
            hotel.baseCurrency as any,
            hotel.isSoloDivisas,
            fx as any
          );
          return {
            room_type_id: r.roomTypeId,
            meal_plan: r.mealPlan,
            occupancy: r.occupancy ?? 1,
            per: (r.pricingUnit === 'per_room' ? 'room' : 'person') as 'room' | 'person',
            price: money,
            min_nights: r.minNights,
          };
        }),
    }));

    // Build from_price using the same multi-room split as catalog
    const undatedRes = calculateUndatedDesde(
      hotel.rooms,
      pureSeasons,
      mealPlans,
      undefined,
      roomsEffective,
      totalGuests,
      hotel.baseCurrency as any,
      hotel.isSoloDivisas,
      fx
    );
    const lowestFromPrice = undatedRes.price;

    // Build stay if dates sent
    let stayData: any = null;
    const hasDates = Boolean(params.check_in && params.check_out);
    if (hasDates && !isGroup) {
      const window = parseStayWindow(params.check_in!, params.check_out!);
      if (!window) {
        throw new InvalidStayWindowError();
      }

      const split = splitGuests(totalGuests, roomsEffective);
      const stayOptions: any[] = [];
      let lowestOptionId: string | null = null;
      let lowestUsdt = Infinity;

      for (const room of hotel.rooms) {
        const fitsParty = room.maxOccupancy >= Math.max(...split);

        for (const mp of mealPlans) {
          const optionId = `${room.id}_${mp}`;

          if (!fitsParty) {
            stayOptions.push({
              id: optionId,
              room_type_id: room.id,
              room_name: room.name,
              meal_plan: mp,
              fits_party: false,
              priced: false,
              reason: 'no_rate',
            });
            continue;
          }

          const roomSelections = split.map((guestsInRoom) => ({
            roomTypeId: room.id,
            adults: guestsInRoom,
            children: 0,
            childAges: [],
          }));

          const priced = priceStay({
            checkIn: window.checkIn,
            checkOut: window.checkOut,
            mealPlan: mp,
            roomSelections,
            baseCurrency: hotel.baseCurrency as any,
            isSoloDivisas: hotel.isSoloDivisas,
            seasons: pureSeasons,
            paymentRules: purePaymentRules,
            fx: fx as any,
            bookingDate,
          });

          if (priced.priced) {
            stayOptions.push({
              id: optionId,
              room_type_id: room.id,
              room_name: room.name,
              meal_plan: mp,
              fits_party: true,
              priced: true,
              total: priced.total,
              methods: priced.methods,
            });

            if (priced.total.usdt < lowestUsdt) {
              lowestUsdt = priced.total.usdt;
              lowestOptionId = optionId;
            }
          } else {
            stayOptions.push({
              id: optionId,
              room_type_id: room.id,
              room_name: room.name,
              meal_plan: mp,
              fits_party: true,
              priced: false,
              reason: priced.reason,
              min_nights_required: priced.minNightsRequired,
            });
          }
        }
      }

      stayData = {
        nights: window.nights,
        rooms_effective: roomsEffective,
        options: stayOptions,
        lowest_option_id: lowestOptionId,
      };
    }

    const latestCheck = hotel.checks[0];
    let publicStatus: 'on_request' | 'available' | 'unavailable' = 'on_request';
    if (latestCheck && (latestCheck.status === 'available' || latestCheck.status === 'unavailable')) {
      publicStatus = latestCheck.status;
    }
    const availability = {
      mode: hotel.availabilityMode as 'manual' | 'api',
      status: publicStatus,
      last_checked_at:
        publicStatus !== 'on_request' && latestCheck?.checkedAt
          ? latestCheck.checkedAt.toISOString()
          : null,
    };

    const firstImage = hotel.images[0];
    const fallbackCoverUrl = firstImage
      ? `${env.FILES_PUBLIC_BASE_URL}/${firstImage.key.replace(/^private\//, 'public/')}`
      : null;
    let coverUrl = hotel.coverImageUrl;
    if (!coverUrl && hotel.coverImageKey) {
      coverUrl = hotel.coverImageKey.startsWith('http://') || hotel.coverImageKey.startsWith('https://')
        ? hotel.coverImageKey
        : `${env.FILES_PUBLIC_BASE_URL}/${hotel.coverImageKey.replace(/^private\//, 'public/')}`;
    }
    coverUrl = coverUrl || fallbackCoverUrl;

    return {
      hotel: {
        slug: hotel.slug,
        name: hotel.name,
        destination: hotel.destination,
        category: hotel.category,
        star_rating: hotel.starRating,
        starRating: hotel.starRating,
        base_currency: hotel.baseCurrency,
        baseCurrency: hotel.baseCurrency,
        is_solo_divisas: hotel.isSoloDivisas,
        isSoloDivisas: hotel.isSoloDivisas,
        description: hotel.description,
        cover_image_url: coverUrl,
        coverImageUrl: coverUrl,
        cover_image_key: hotel.coverImageKey || (firstImage ? firstImage.key : null),
        coverImageKey: hotel.coverImageKey || (firstImage ? firstImage.key : null),
        images: hotel.images.map((img) => ({
          id: img.id,
          key: img.key,
          url: `${env.FILES_PUBLIC_BASE_URL}/${img.key.replace(/^private\//, 'public/')}`,
          alt: img.alt,
          sort_order: img.sortOrder,
          sortOrder: img.sortOrder,
        })),
        meal_plans: mealPlans,
      },
      rooms: hotel.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        max_occupancy: r.maxOccupancy,
      })),
      seasonal_rates: seasonalRates,
      from_price: lowestFromPrice ? { price: lowestFromPrice, per: 'night' as const } : null,
      stay: stayData,
      availability,
      group_request: groupRequest,
      exchange: fx,
    };
  }

  async priceCheckout(slug: string, body: {
    check_in: string;
    check_out: string;
    meal_plan: string;
    room_selections: {
      room_type_id: string;
      adults: number;
      children: number;
      child_ages: number[];
    }[];
  }) {
    const hotel = await prisma.hotel.findUnique({
      where: { slug },
      include: {
        seasons: {
          where: { isActive: true },
          include: { rates: { where: { isActive: true } } },
        },
        paymentRules: true,
      },
    });

    if (!hotel || !hotel.isActive) {
      throw new NotFoundError(`Hotel with slug '${slug}' not found`);
    }

    const totalRooms = body.room_selections.length;
    const totalGuests = body.room_selections.reduce(
      (sum, r) => sum + r.adults + r.children,
      0
    );

    if (totalRooms >= env.GROUP_MIN_ROOMS || totalGuests >= env.GROUP_MIN_GUESTS) {
      return {
        priced: false as const,
        reason: 'group_request' as const,
        group_request: {
          whatsapp_url: `https://wa.me/584120000000?text=${encodeURIComponent(`Cotizacion grupal ${hotel.name}`)}`,
          email: 'reservas@vuelitos.com',
        },
      };
    }

    const window = parseStayWindow(body.check_in, body.check_out);
    if (!window) {
      throw new InvalidStayWindowError();
    }

    const fx = await ratesService.getLatestEffectiveRates();
    const bookingDate = env.PRICING_NOW || getCaracasWallDate();

    const pureSeasons: SeasonInput[] = hotel.seasons.map((s) => ({
      id: s.id,
      hotelId: s.hotelId,
      name: s.name,
      priority: s.priority,
      dateFrom: s.dateFrom.toISOString().slice(0, 10),
      dateTo: s.dateTo.toISOString().slice(0, 10),
      bookingFrom: s.bookingFrom ? s.bookingFrom.toISOString().slice(0, 10) : null,
      bookingTo: s.bookingTo ? s.bookingTo.toISOString().slice(0, 10) : null,
      isActive: s.isActive,
      rates: s.rates.map((r) => ({
        id: r.id,
        roomTypeId: r.roomTypeId,
        seasonId: r.seasonId,
        mealPlan: r.mealPlan,
        concept: r.concept as any,
        priceKind: r.priceKind as any,
        occupancy: r.occupancy,
        pricingUnit: r.pricingUnit as any,
        netRate: r.netRate.toString(),
        daysOfWeek: r.daysOfWeek,
        minNights: r.minNights,
        maxNights: r.maxNights,
        isActive: r.isActive,
      })),
    }));

    const purePaymentRules = hotel.paymentRules.map((pr) => ({
      method: pr.method as any,
      ivaRate: Number(pr.ivaRate),
      surchargePercent: pr.surchargePercent ? Number(pr.surchargePercent) : null,
    }));

    const roomSelections = body.room_selections.map((rs) => ({
      roomTypeId: rs.room_type_id,
      adults: rs.adults,
      children: rs.children,
      childAges: rs.child_ages,
    }));

    const result = priceStay({
      checkIn: body.check_in,
      checkOut: body.check_out,
      mealPlan: body.meal_plan,
      roomSelections,
      baseCurrency: hotel.baseCurrency as any,
      isSoloDivisas: hotel.isSoloDivisas,
      seasons: pureSeasons,
      paymentRules: purePaymentRules,
      fx: fx as any,
      bookingDate,
    });

    if (!result.priced) {
      return {
        priced: false as const,
        reason: result.reason,
        min_nights_required: result.minNightsRequired,
      };
    }

    return {
      priced: true as const,
      nights: result.nights,
      base_currency: result.baseCurrency,
      rooms: result.rooms.map((r) => ({
        room_type_id: r.roomTypeId,
        guests: r.guests,
        price: r.price,
      })),
      total: result.total,
      methods: result.methods,
      exchange: fx,
    };
  }
}

export const catalogService = new CatalogService();
