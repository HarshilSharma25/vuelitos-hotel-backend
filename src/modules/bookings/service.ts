import { BookingStatus, PaymentMethod, PaymentMode, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { resolveCoverImageUrl } from '../files/public-url.js';
import { ratesService } from '../rates/service.js';
import { settingsService } from '../settings/service.js';
import { notifier } from '../notifications/notifier.js';
import {
  generateAccessToken,
  generateBookingCode,
  verifyAccessToken,
} from '../../lib/ids.js';
import { calculateSlaDueAt, getCaracasWallDate } from '../../lib/caracas-time.js';
import { asNumberArray } from '../../lib/json.js';
import {
  BadRequestError,
  GroupRequestRequiredError,
  InvalidStayWindowError,
  InvalidTransitionError,
  NotFoundError,
  ForbiddenError,
  StayNotBookableError,
  AppError,
} from '../../lib/errors.js';
import { flightInternalClient } from '../../lib/flight-internal.js';
import {
  parseStayWindow,
  priceStay,
  SeasonInput,
} from '../pricing/index.js';
import { getAllowedActions, transition, ActorType } from './state-machine.js';
import { recordBookingTransition } from '../../lib/metrics.js';
import {
  derivePaymentStatus,
  deriveRefundStatus,
  hasConfirmationDocument,
} from '../../lib/payment-status.js';
import { refundService } from '../refunds/service.js';
import { buildBookingMailPayload } from '../../lib/booking-mail-data.js';
import { resolveDisplayLocale } from '../../lib/display-locale.js';

export const STATUS_LABELS: Record<
  'es' | 'en',
  Record<BookingStatus, { label: string; description: string }>
> = {
  es: {
    requested: {
      label: 'Solicitud recibida',
      description: 'Hemos recibido tu solicitud y consultaremos disponibilidad con el hotel.',
    },
    checking_availability: {
      label: 'Consultando disponibilidad',
      description: 'Nuestro equipo está confirmando las habitaciones con el hotel.',
    },
    awaiting_payment: {
      label: 'Esperando pago',
      description: 'El hotel ha confirmado disponibilidad. Por favor realiza tu pago.',
    },
    payment_submitted: {
      label: 'Pago reportado',
      description: 'Hemos recibido tu reporte de pago y nuestro equipo lo está verificando.',
    },
    payment_verified: {
      label: 'Pago verificado',
      description: 'Tu pago ha sido verificado satisfactoriamente. Emitiendo confirmación.',
    },
    confirmed: {
      label: 'Reserva confirmada',
      description: '¡Tu reserva está completamente confirmada!',
    },
    alternatives_offered: {
      label: 'Alternativas ofrecidas',
      description:
        'El hotel seleccionado no tiene cupo en esas fechas, pero te hemos enviado opciones similares.',
    },
    unavailable: {
      label: 'No disponible',
      description: 'Lamentablemente no hay disponibilidad para estas fechas.',
    },
    cancelled: {
      label: 'Cancelada',
      description: 'La solicitud ha sido cancelada.',
    },
    refund_pending: {
      label: 'Reembolso en proceso',
      description: 'La reserva fue cancelada y el reembolso está siendo tramitado.',
    },
    refunded: {
      label: 'Reembolsada',
      description: 'El reembolso ha sido procesado exitosamente.',
    },
  },
  en: {
    requested: {
      label: 'Request received',
      description: 'We have received your request and are checking availability with the hotel.',
    },
    checking_availability: {
      label: 'Checking availability',
      description: 'Our team is confirming rooms directly with the hotel.',
    },
    awaiting_payment: {
      label: 'Awaiting payment',
      description: 'The hotel has confirmed availability. Please submit your payment.',
    },
    payment_submitted: {
      label: 'Payment submitted',
      description: 'Payment report received and is currently being verified by our team.',
    },
    payment_verified: {
      label: 'Payment verified',
      description: 'Your payment has been verified. Final confirmation in progress.',
    },
    confirmed: {
      label: 'Booking confirmed',
      description: 'Your hotel booking is confirmed!',
    },
    alternatives_offered: {
      label: 'Alternatives offered',
      description: 'The selected hotel is full, but we have offered similar options.',
    },
    unavailable: {
      label: 'Unavailable',
      description: 'Unfortunately there is no availability for the selected dates.',
    },
    cancelled: {
      label: 'Cancelled',
      description: 'The booking request has been cancelled.',
    },
    refund_pending: {
      label: 'Refund pending',
      description: 'The booking was cancelled and your refund is being processed.',
    },
    refunded: {
      label: 'Refunded',
      description: 'Your refund has been completed.',
    },
  },
};

export const EVENT_LABELS: Record<'es' | 'en', Record<string, string>> = {
  es: {
    start_request: 'Solicitud creada por el cliente',
    requested: 'Solicitud enviada',
    start_availability_check: 'Equipo inició consulta con el hotel',
    confirm_availability: 'Hotel confirmó disponibilidad',
    offer_alternatives: 'Se enviaron opciones alternativas',
    choose_alternative: 'Cliente aceptó alternativa',
    decline_alternatives: 'Cliente rechazó alternativas',
    mark_unavailable: 'Hotel sin disponibilidad',
    submit_payment: 'Cliente reportó pago',
    verify_payment: 'Pago verificado por el equipo',
    reject_payment: 'Reporte de pago rechazado',
    confirm_booking: 'Reserva confirmada con el hotel',
    expire_payment_window: 'Ventana de pago expirada',
    cancel: 'Solicitud cancelada',
    complete_refund: 'Reembolso completado',
    start_check: 'Equipo inició consulta con el hotel',
    hotel_confirmed: 'Hotel confirmó disponibilidad',
    accept_alternative: 'Cliente aceptó alternativa',
  },
  en: {
    start_request: 'Request created by customer',
    requested: 'Request submitted',
    start_availability_check: 'Team started checking with hotel',
    confirm_availability: 'Hotel confirmed availability',
    offer_alternatives: 'Alternative stays offered',
    choose_alternative: 'Customer accepted alternative',
    decline_alternatives: 'Customer declined alternatives',
    mark_unavailable: 'Hotel has no availability',
    submit_payment: 'Customer reported payment',
    verify_payment: 'Payment verified by staff',
    reject_payment: 'Payment report rejected',
    confirm_booking: 'Booking confirmed with hotel',
    expire_payment_window: 'Payment window expired',
    cancel: 'Booking cancelled',
    complete_refund: 'Refund completed',
    start_check: 'Team started checking with hotel',
    hotel_confirmed: 'Hotel confirmed availability',
    accept_alternative: 'Customer accepted alternative',
  },
};

export class BookingService {
  async createBooking(body: any, meta: { ip?: string; userId?: string } = {}) {
    let totalRooms = 0;
    let totalGuests = 0;
    for (const item of body.items) {
      totalRooms += item.room_selections.length;
      totalGuests += item.room_selections.reduce(
        (sum: number, r: any) => sum + r.adults + r.children,
        0
      );
    }

    if (totalRooms >= env.GROUP_MIN_ROOMS || totalGuests >= env.GROUP_MIN_GUESTS) {
      throw new GroupRequestRequiredError();
    }

    const fx = await ratesService.getLatestEffectiveRates();
    const bookingDate = env.PRICING_NOW || getCaracasWallDate();

    const pricedItems: any[] = [];
    let combinedTotalsByMethod: any[] = [];

    for (const item of body.items) {
      const hotel = await prisma.hotel.findUnique({
        where: { slug: item.hotel_slug },
        include: {
          rooms: { where: { isActive: true } },
          seasons: {
            where: { isActive: true },
            include: { rates: { where: { isActive: true } } },
          },
          paymentRules: true,
        },
      });

      if (!hotel || !hotel.isActive) {
        throw new StayNotBookableError(`Hotel '${item.hotel_slug}' not found or inactive`);
      }

      const window = parseStayWindow(item.check_in, item.check_out);
      if (!window) {
        throw new InvalidStayWindowError();
      }

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
          daysOfWeek: asNumberArray(r.daysOfWeek),
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

      const roomSelections = item.room_selections.map((rs: any) => ({
        roomTypeId: rs.room_type_id,
        adults: rs.adults,
        children: rs.children,
        childAges: rs.child_ages,
      }));

      const priced = priceStay({
        checkIn: item.check_in,
        checkOut: item.check_out,
        mealPlan: item.meal_plan,
        roomSelections,
        baseCurrency: hotel.baseCurrency as any,
        isSoloDivisas: hotel.isSoloDivisas,
        childBandsEnabled: (hotel as any).childBandsEnabled ?? false,
        seasons: pureSeasons,
        paymentRules: purePaymentRules,
        fx: fx as any,
        bookingDate,
      });

      if (!priced.priced) {
        throw new StayNotBookableError(
          `Stay not bookable: ${priced.reason}`,
          priced.minNightsRequired ? { min_nights_required: priced.minNightsRequired } : undefined
        );
      }

      pricedItems.push({
        hotelId: hotel.id,
        item,
        priced,
      });

    }

    if (pricedItems.length > 0) {
      const itemMethodMaps = pricedItems.map((pi) => {
        const map = new Map<string, any>();
        for (const m of pi.priced.methods) {
          map.set(m.method, m);
        }
        return map;
      });

      const firstMethods = pricedItems[0].priced.methods.map((m: any) => m.method);
      const commonMethods = firstMethods.filter((method: string) =>
        itemMethodMaps.every((map) => map.has(method))
      );

      if (commonMethods.length === 0) {
        throw new StayNotBookableError(
          'No payment methods available for the combined booking items'
        );
      }

      const bcvUsd = (fx as any).bcvUsd ?? fx.bcv_usd;
      const bcvEur = (fx as any).bcvEur ?? fx.bcv_eur;

      const combinedList: any[] = [];
      for (const method of commonMethods) {
        let totalAmount = 0;
        let totalIvaAmount = 0;
        const firstEntry = itemMethodMaps[0].get(method)!;

        for (const map of itemMethodMaps) {
          const entry = map.get(method)!;
          totalAmount += entry.amount;
          totalIvaAmount += entry.iva_amount;
        }

        combinedList.push({
          method: firstEntry.method,
          currency: firstEntry.currency,
          amount: Math.round(totalAmount * 100) / 100,
          iva_rate: firstEntry.iva_rate,
          iva_amount: Math.round(totalIvaAmount * 100) / 100,
          exchange_rate_used: firstEntry.exchange_rate_used,
          is_lowest: false,
        });
      }

      let minUsdEquiv = Infinity;
      const usdEquivs = combinedList.map((entry) => {
        let usd = entry.amount;
        if (entry.currency === 'VES' && bcvUsd) {
          usd = entry.amount / bcvUsd;
        } else if (entry.currency === 'EUR' && bcvEur && bcvUsd) {
          usd = (entry.amount * bcvEur) / bcvUsd;
        }
        if (usd < minUsdEquiv) {
          minUsdEquiv = usd;
        }
        return usd;
      });

      combinedList.forEach((entry, idx) => {
        entry.is_lowest = Math.abs(usdEquivs[idx] - minUsdEquiv) < 0.001;
      });

      combinedTotalsByMethod = combinedList;
    }

    const checkoutMode = (body as any).checkout_mode || 'pay_now';
    const primaryHotelId = pricedItems[0]?.hotelId;
    const effectiveSettings = await settingsService.getEffectiveCheckoutSettings(primaryHotelId);

    let paymentMode: PaymentMode = PaymentMode.online;
    let paymentWindowHours: number | null = effectiveSettings.paymentWindowHours;
    let paymentMethodPref = body.payment_method || null;

    if (checkoutMode === 'pay_at_hotel') {
      if (!effectiveSettings.payAtHotelEnabled) {
        throw new BadRequestError('Pay at hotel is not enabled for this property');
      }
      paymentMode = PaymentMode.at_hotel;
      paymentWindowHours = null;
      paymentMethodPref = (body.payment_method as any) || PaymentMethod.cash_usd;
    } else {
      if (!effectiveSettings.payNowEnabled) {
        throw new BadRequestError('Pay now is not enabled for this property');
      }
      paymentMode = PaymentMode.online;
      paymentWindowHours = effectiveSettings.paymentWindowHours;
    }

    const now = new Date();
    let slaDueAt: Date | null = null;
    let initialStatus: BookingStatus = BookingStatus.requested;

    if (paymentMode === PaymentMode.at_hotel) {
      initialStatus = BookingStatus.requested;
      const holidays = await prisma.holiday.findMany({ select: { date: true } });
      const holidayDateStrings = holidays.map((h) => h.date.toISOString().slice(0, 10));
      slaDueAt = calculateSlaDueAt(now, holidayDateStrings);
    } else {
      initialStatus = BookingStatus.awaiting_payment;
      const windowHours = paymentWindowHours ?? effectiveSettings.paymentWindowHours ?? 48;
      slaDueAt = new Date(now.getTime() + windowHours * 3600 * 1000);
    }

    const { token, accessKey } = generateAccessToken();

    const created = await prisma.$transaction(async (tx) => {
      const code = await generateBookingCode(tx);

      const booking = await tx.booking.create({
        data: {
          code,
          status: initialStatus,
          userId: meta.userId ? String(meta.userId) : null,
          accessKey,
          locale: body.locale || 'es',
          contactName: body.contact.name,
          contactEmail: body.contact.email,
          contactPhone: body.contact.phone || null,
          notes: body.notes || body.guest_details?.special_requests || null,
          guestDetails: body.guest_details ? (body.guest_details as any) : null,
          paymentMode,
          paymentWindowHours,
          remindersSent: [],
          paymentMethodPref,
          termsAcceptedAt: now,
          totalsByMethod: combinedTotalsByMethod as any,
          fxSnapshot: {
            bcv_usd: fx.bcv_usd,
            bcv_eur: fx.bcv_eur,
            binance_usdt: fx.binance_usdt,
            bcv_value_date: fx.bcv_value_date,
          },
          slaDueAt,
        },
      });

      for (const pi of pricedItems) {
        await tx.bookingItem.create({
          data: {
            bookingId: booking.id,
            type: 'hotel_stay',
            hotelId: pi.hotelId,
            checkIn: new Date(`${pi.item.check_in}T00:00:00Z`),
            checkOut: new Date(`${pi.item.check_out}T00:00:00Z`),
            mealPlan: pi.item.meal_plan,
            roomSelections: pi.item.room_selections,
            priceSnapshot: {
              total: pi.priced.total,
              rooms: pi.priced.rooms.map((r: any) => ({
                room_type_id: r.roomTypeId,
                guests: r.guests,
                price: r.price,
              })),
            },
          },
        });

        await tx.availabilityCheck.create({
          data: {
            bookingId: booking.id,
            hotelId: pi.hotelId,
            checkIn: new Date(`${pi.item.check_in}T00:00:00Z`),
            checkOut: new Date(`${pi.item.check_out}T00:00:00Z`),
            status: 'pending',
          },
        });
      }

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: 'requested',
          fromStatus: null,
          toStatus: initialStatus,
          actorType: 'customer',
          actorId: null,
          note: 'Solicitud creada',
        },
      });

      return {
        code: booking.code,
        access_token: token,
        status: booking.status,
        payment_mode: booking.paymentMode,
        sla_due_at: slaDueAt ? slaDueAt.toISOString() : null,
      };
    });

    await notifier.sendBookingCreatedNotice({
      code: created.code,
      contactName: body.contact.name,
      contactEmail: body.contact.email,
      accessToken: token,
    });

    return created;
  }

  async getBookingView(
    code: string,
    token?: string,
    user?: { id: string; role?: string },
    displayLocale?: string
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: {
        items: true,
        events: { orderBy: { createdAt: 'desc' } },
        payments: { orderBy: { submittedAt: 'desc' } },
      },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const hasToken = token ? verifyAccessToken(token, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;

    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) {
        isOwner = true;
      }
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) {
        isStaff = true;
      }
    }

    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const locale = resolveDisplayLocale(booking.locale, displayLocale);
    const statusMeta = STATUS_LABELS[locale][booking.status] || STATUS_LABELS.es[booking.status];

    let paymentDueAt: string | null = null;
    if (booking.status === BookingStatus.awaiting_payment && booking.slaDueAt) {
      paymentDueAt = booking.slaDueAt.toISOString();
    }

    const itemsFormatted: any[] = [];
    for (const item of booking.items) {
      const hotel = await prisma.hotel.findUnique({
        where: { id: item.hotelId },
        include: { rooms: true },
      });

      const roomNameMap = new Map<string, string>();
      hotel?.rooms.forEach((r) => roomNameMap.set(r.id, r.name));

      const rawSelections = item.roomSelections as any[];
      const priceSnap = item.priceSnapshot as any;

      const formattedRooms = rawSelections.map((sel: any) => ({
        room_type_id: sel.room_type_id,
        room_name: roomNameMap.get(sel.room_type_id) || 'Habitacion',
        adults: sel.adults,
        children: sel.children,
        child_ages: sel.child_ages || [],
      }));

      const nights = Math.round(
        (item.checkOut.getTime() - item.checkIn.getTime()) / (1000 * 60 * 60 * 24)
      );

      itemsFormatted.push({
        type: 'hotel_stay',
        hotel: {
          slug: hotel?.slug || '',
          name: hotel?.name || '',
          destination: hotel?.destination || '',
        },
        check_in: item.checkIn.toISOString().slice(0, 10),
        check_out: item.checkOut.toISOString().slice(0, 10),
        nights,
        meal_plan: item.mealPlan,
        rooms: formattedRooms,
        price: priceSnap.total,
      });
    }

    const timeline = booking.events.map((ev) => {
      const label =
        EVENT_LABELS[locale][ev.event] ||
        EVENT_LABELS.es[ev.event] ||
        ev.event;
      return {
        at: ev.createdAt.toISOString(),
        event: ev.event,
        label,
      };
    });

    const payments = booking.payments.map((p) => ({
      id: p.id,
      method: p.method,
      currency: p.currency as any,
      amount: Number(p.amountQuoted),
      reference: p.reference,
      status: p.status as any,
      submitted_at: p.submittedAt.toISOString(),
    }));

    const latestRefund = await prisma.refundRequest.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
    });

    const refundEligibility = await refundService.computeEligibilityForBooking({
      id: booking.id,
      status: booking.status,
      paymentMode: booking.paymentMode,
      payments: booking.payments,
    });

    const hotelId = booking.items[0]?.hotelId;
    const cardAvailable = hotelId ? await settingsService.isStripeCardAvailable(hotelId) : false;

    let allowedActions = refundService.filterAllowedActions(
      getAllowedActions(booking.status, booking.paymentMode as any, booking.items[0]?.checkIn),
      refundEligibility
    );

    return {
      code: booking.code,
      status: booking.status,
      payment_status: derivePaymentStatus({
        status: booking.status,
        paymentMode: booking.paymentMode,
      }),
      refund_status: deriveRefundStatus(latestRefund),
      has_confirmation_document: hasConfirmationDocument(booking.status),
      status_label: statusMeta.label,
      status_description: statusMeta.description,
      payment_mode: booking.paymentMode,
      sla_due_at: booking.slaDueAt ? booking.slaDueAt.toISOString() : null,
      payment_due_at: paymentDueAt,
      contact: {
        name: booking.contactName,
        email: booking.contactEmail,
      },
      items: itemsFormatted,
      totals_by_method: cardAvailable
        ? (booking.totalsByMethod as any)
        : ((booking.totalsByMethod as any[]) || []).filter((m: any) => m.method !== 'stripe_card'),
      exchange_snapshot: booking.fxSnapshot as any,
      payments,
      timeline,
      guest_details: (booking as any).guestDetails ? ((booking as any).guestDetails as any) : undefined,
      allowed_actions: allowedActions,
      refund_eligibility: refundEligibility,
      payment_receipt_available: booking.payments.some((p) => Boolean(p.proofStorageKey)),
      created_at: booking.createdAt.toISOString(),
    };
  }

  async reportPayment(code: string, body: { token?: string; method: PaymentMethod; reference: string }, tokenParam?: string, user?: { id: string; role?: string }) {
    const booking = await prisma.booking.findUnique({
      where: { code },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const effectiveToken = body.token || tokenParam;
    const hasToken = effectiveToken ? verifyAccessToken(effectiveToken, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;

    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) {
        isOwner = true;
      }
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) {
        isStaff = true;
      }
    }

    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    if (booking.status === BookingStatus.requested) {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.awaiting_payment },
        });
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_availability',
            fromStatus: BookingStatus.requested,
            toStatus: BookingStatus.awaiting_payment,
            actorType: 'system',
            note: 'Transición a awaiting_payment para reporte de pago',
          },
        });
      });
      booking.status = BookingStatus.awaiting_payment;
    }

    const allowed = getAllowedActions(booking.status);
    if (!allowed.includes('report_payment')) {
      throw new InvalidTransitionError('Cannot report payment for this booking in current status');
    }

    const next = transition({
      currentStatus: booking.status,
      event: 'submit_payment',
      actorType: 'customer',
      note: `Pago reportado ref: ${body.reference}`,
    });

    const totals = booking.totalsByMethod as any[];
    const methodTotal = totals.find((t) => t.method === body.method);
    const amountQuoted = methodTotal ? methodTotal.amount : 0;
    const currency = methodTotal ? methodTotal.currency : 'USD';

    await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: next.fromStatus },
        data: { status: next.toStatus },
      });

      if (updated.count === 0) {
        throw new InvalidTransitionError('State transition conflict');
      }

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          method: body.method,
          currency,
          amountQuoted,
          reference: body.reference,
          status: 'submitted',
        },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: next.event,
          fromStatus: next.fromStatus,
          toStatus: next.toStatus,
          actorType: next.actorType,
          actorId: null,
          note: next.note,
        },
      });
    });

    recordBookingTransition(next.event);

    return this.getBookingView(code, effectiveToken, user);
  }

  async cancelBooking(code: string, token?: string, user?: { id: string; role?: string }) {
    const booking = await prisma.booking.findUnique({
      where: { code },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const hasToken = token ? verifyAccessToken(token, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;

    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) {
        isOwner = true;
      }
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) {
        isStaff = true;
      }
    }

    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const next = transition({
      currentStatus: booking.status,
      event: 'cancel',
      actorType: 'customer',
      note: 'Cancelado por el cliente',
    });

    await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: next.fromStatus },
        data: { status: next.toStatus },
      });

      if (updated.count === 0) {
        throw new InvalidTransitionError('State transition conflict');
      }

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: next.event,
          fromStatus: next.fromStatus,
          toStatus: next.toStatus,
          actorType: next.actorType,
          actorId: null,
          note: next.note,
        },
      });
    });

    recordBookingTransition(next.event);

    return this.getBookingView(code, token, user);
  }

  async getCustomerBookings(
    userId: string,
    opts: { tab?: string; cursor?: string; limit?: number; displayLocale?: string } = {}
  ) {
    const limit = Math.min(50, Math.max(1, opts.limit || 20));
    const tab = opts.tab || 'all';

    const where: any = { userId: String(userId) };
    const now = new Date();

    if (tab === 'upcoming') {
      where.status = { in: ['requested', 'checking_availability', 'awaiting_payment', 'payment_submitted', 'payment_verified', 'confirmed', 'alternatives_offered'] };
      where.items = { some: { checkOut: { gte: now } } };
    } else if (tab === 'awaiting_payment') {
      where.status = 'awaiting_payment';
    } else if (tab === 'completed') {
      where.status = { in: ['confirmed', 'refunded'] };
    } else if (tab === 'cancelled_refunds') {
      where.status = { in: ['cancelled', 'unavailable', 'refund_pending', 'refunded'] };
    }

    if (opts.cursor) {
      const cursorBooking = await prisma.booking.findUnique({ where: { id: opts.cursor } });
      if (cursorBooking) {
        where.createdAt = { lt: cursorBooking.createdAt };
      }
    }

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        items: true,
        payments: { orderBy: { submittedAt: 'desc' }, take: 1 },
        refundRequests: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const hasMore = bookings.length > limit;
    const page = hasMore ? bookings.slice(0, limit) : bookings;
    const hotelIds = [...new Set(page.flatMap((b) => b.items.map((i) => i.hotelId)))];
    const hotels = await prisma.hotel.findMany({
      where: { id: { in: hotelIds } },
      select: { id: true, name: true, destination: true, coverImageUrl: true, coverImageKey: true },
    });
    const hotelMap = new Map(hotels.map((h) => [h.id, h]));

    const items = await Promise.all(
      page.map(async (b) => {
        const item = b.items[0];
        const hotel = item ? hotelMap.get(item.hotelId) : undefined;
        const snap = item?.priceSnapshot as any;
        const refundEligibility = await refundService.computeEligibilityForBooking({
          id: b.id,
          status: b.status,
          paymentMode: b.paymentMode,
          payments: b.payments,
        });
        let allowedActions = refundService.filterAllowedActions(
          getAllowedActions(b.status, b.paymentMode as any, item?.checkIn),
          refundEligibility
        );
        const totals = (b.totalsByMethod as any[]) || [];
        const primaryTotal = totals[0];
        const guests = item
          ? (item.roomSelections as any[]).reduce(
              (s, r) => s + (r.adults || 0) + (r.children || 0),
              0
            )
          : 0;

        const listLocale = resolveDisplayLocale(b.locale, opts.displayLocale);
        const listStatusMeta =
          STATUS_LABELS[listLocale][b.status] || STATUS_LABELS.es[b.status];

        return {
          id: b.id,
          code: b.code,
          status: b.status,
          status_label: listStatusMeta.label,
          payment_status: derivePaymentStatus({ status: b.status, paymentMode: b.paymentMode }),
          refund_status: deriveRefundStatus(b.refundRequests[0]),
          hotel_name: hotel?.name ?? '',
          hotel_cover_image: hotel
            ? resolveCoverImageUrl(hotel.coverImageKey, hotel.coverImageUrl)
            : null,
          city: hotel?.destination ?? '',
          check_in: item?.checkIn.toISOString().slice(0, 10) ?? null,
          check_out: item?.checkOut.toISOString().slice(0, 10) ?? null,
          guests,
          total: primaryTotal ? Number(primaryTotal.amount) : snap?.total?.amount ?? null,
          currency: primaryTotal?.currency ?? snap?.total?.currency ?? null,
          sla_due_at: b.slaDueAt?.toISOString() ?? null,
          allowed_actions: allowedActions,
          has_confirmation_document: hasConfirmationDocument(b.status),
          created_at: b.createdAt.toISOString(),
        };
      })
    );

    return {
      items,
      next_cursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async claimBooking(
    code: string,
    accessToken: string,
    userId: string
  ): Promise<{ success: boolean; code: string }> {
    const booking = await prisma.booking.findUnique({ where: { code } });
    if (!booking) throw new NotFoundError('Booking not found');
    if (!verifyAccessToken(accessToken, booking.accessKey)) {
      throw new ForbiddenError('Invalid access token');
    }
    if (booking.userId && String(booking.userId) !== String(userId)) {
      throw new ForbiddenError('Booking is linked to another account');
    }
    if (booking.userId) {
      return { success: true, code: booking.code };
    }
    await prisma.booking.update({
      where: { id: booking.id },
      data: { userId: String(userId) },
    });
    return { success: true, code: booking.code };
  }

  async streamConfirmationPdf(
    code: string,
    token?: string,
    user?: { id: string; role?: string }
  ): Promise<{ buffer: Buffer; filename: string }> {
    const view = await this.getBookingView(code, token, user);
    if (!hasConfirmationDocument(view.status as BookingStatus)) {
      throw new BadRequestError('Confirmation is not available for this booking');
    }

    const booking = await prisma.booking.findUnique({ where: { code } });
    if (!booking) throw new NotFoundError('Booking not found');

    const cacheKey = `pdf:v2:${code}:${booking.updatedAt.getTime()}`;
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        const cached = await redis.getBuffer(cacheKey);
        if (cached) {
          return { buffer: cached, filename: `Vuelitos-${code}.pdf` };
        }
      }
    } catch {
    }

    const mailPayload = await buildBookingMailPayload(code);
    let pdf: Buffer;
    try {
      pdf = await flightInternalClient.fetchConfirmationPdf(mailPayload as any);
    } catch (err: any) {
      logger.warn(
        { bookingCode: code, err: err?.message },
        '[ConfirmationPdf] Flight document service failed'
      );
      throw new AppError(
        503,
        'PDF_UNAVAILABLE',
        'Confirmation PDF could not be generated. Try again later or contact support.'
      );
    }

    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.setex(cacheKey, 120, pdf);
      }
    } catch {
    }

    return { buffer: pdf, filename: `Vuelitos-${code}.pdf` };
  }

  async createStripePaymentSession(
    code: string,
    tokenParam?: string,
    user?: { id: string; role?: string },
    origin?: string
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: { items: true },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const effectiveToken = tokenParam;
    const hasToken = effectiveToken ? verifyAccessToken(effectiveToken, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;

    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) {
        isOwner = true;
      }
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) {
        isStaff = true;
      }
    }

    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const hotelId = booking.items[0]?.hotelId;
    if (hotelId) {
      const isCardAvailable = await settingsService.isStripeCardAvailable(hotelId);
      if (!isCardAvailable) {
        throw new BadRequestError('Card payments are disabled');
      }
    }

    if (booking.status === BookingStatus.requested) {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.awaiting_payment },
        });
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_availability',
            fromStatus: BookingStatus.requested,
            toStatus: BookingStatus.awaiting_payment,
            actorType: 'system',
            note: 'Transición a awaiting_payment para iniciar sesión de Stripe',
          },
        });
      });
      booking.status = BookingStatus.awaiting_payment;
    }

    if (booking.status !== BookingStatus.awaiting_payment) {
      throw new InvalidTransitionError('Stripe session can only be created when booking is awaiting_payment');
    }

    const totals = (booking.totalsByMethod as any[]) || [];
    const stripeEntry = totals.find((t: any) => t.method === 'stripe_card');
    if (!stripeEntry) {
      throw new BadRequestError('Stripe card payment is not available for this booking');
    }

    const amountCents = Math.round(Number(stripeEntry.amount) * 100);
    const currency = String(stripeEntry.currency).toLowerCase();

    const attempt =
      (await prisma.payment.count({
        where: { bookingId: booking.id, method: 'stripe_card' },
      })) + 1;

    const idempotencyKey = `hotel-${code}-${attempt}`;
    const returnBase = origin
      ? `${origin.replace(/\/+$/, '')}/booking/payment-status`
      : env.CARD_RETURN_URL_BASE;
    const successUrl = `${returnBase}?code=${code}&status=success`;
    const cancelUrl = `${returnBase}?code=${code}&status=cancel`;

    const session = await flightInternalClient.createCheckoutSession({
      hotel_booking_code: code,
      amount_cents: amountCents,
      currency,
      customer_email: booking.contactEmail,
      success_url: successUrl,
      cancel_url: cancelUrl,
      idempotency_key: idempotencyKey,
    });

    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        method: 'stripe_card',
        currency: stripeEntry.currency,
        amountQuoted: stripeEntry.amount,
        reference: session.session_id,
        status: 'pending',
        externalProvider: 'stripe',
        externalSessionId: session.session_id,
        rawStatus: 'open',
      },
    });

    return {
      checkout_url: session.checkout_url,
      expires_at: session.expires_at,
    };
  }

  async getBookingStatus(
    code: string,
    token?: string,
    user?: { id: string; role?: string },
    displayLocale?: string
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: { items: true },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const hasToken = token ? verifyAccessToken(token, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;
    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) isOwner = true;
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) isStaff = true;
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const locale = resolveDisplayLocale(booking.locale, displayLocale);
    const statusMeta = STATUS_LABELS[locale][booking.status] || STATUS_LABELS.es[booking.status];

    const etag = `W/"${booking.status}-${booking.updatedAt.getTime()}-${booking.slaDueAt?.getTime() ?? 0}"`;
    const checkInDate = booking.items[0]?.checkIn;
    const allowedActions = getAllowedActions(
      booking.status,
      booking.paymentMode as any,
      checkInDate
    );

    return {
      etag,
      data: {
        code: booking.code,
        status: booking.status,
        status_label: statusMeta.label,
        payment_mode: booking.paymentMode,
        sla_due_at: booking.slaDueAt ? booking.slaDueAt.toISOString() : null,
        updated_at: booking.updatedAt.toISOString(),
        allowed_actions: allowedActions,
      },
    };
  }

  async resendAccessLink(code: string, email?: string) {
    const booking = await prisma.booking.findUnique({
      where: { code },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    if (email && email.trim().toLowerCase() !== booking.contactEmail.trim().toLowerCase()) {
      throw new BadRequestError('Provided email does not match booking contact email');
    }

    const { token, accessKey } = generateAccessToken();
    await prisma.booking.update({
      where: { id: booking.id },
      data: { accessKey },
    });

    await notifier.sendAccessLinkNotice({
      code: booking.code,
      contactName: booking.contactName,
      contactEmail: booking.contactEmail,
      accessToken: token,
    });

    return { success: true, message: 'Access link sent to contact email' };
  }

  async refreshStripePaymentSession(code: string, token?: string, user?: { id: string; role?: string }) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: {
        items: true,
        payments: { orderBy: { submittedAt: 'desc' } },
      },
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    const hasToken = token ? verifyAccessToken(token, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;
    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) isOwner = true;
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) isStaff = true;
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const cooldownKey = `rate:refresh:${code}`;
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        const setOk = await redis.set(cooldownKey, '1', 'EX', 3, 'NX');
        if (!setOk) {
          return {
            status: booking.status,
            payment_status: booking.payments[0]?.status ?? 'none',
            message: 'Refresh cooldown active',
          };
        }
      }
    } catch {
    }

    const payment = booking.payments.find((p) => p.method === 'stripe_card');
    if (!payment || !payment.externalSessionId) {
      return {
        status: booking.status,
        payment_status: payment?.status ?? 'none',
        message: 'No Stripe session found for this booking',
      };
    }

    const sessionStatus = await flightInternalClient.getSessionStatus(payment.externalSessionId);

    if (sessionStatus.status === 'complete' || sessionStatus.payment_status === 'paid') {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'verified',
            verifiedAt: new Date(),
            verifiedBy: 'stripe_refresh',
            rawStatus: sessionStatus.status,
            amountReceived: payment.amountQuoted,
          },
        });

        if (booking.status === 'awaiting_payment' || booking.status === 'payment_submitted') {
          if (booking.status === 'awaiting_payment') {
            await tx.bookingEvent.create({
              data: {
                bookingId: booking.id,
                event: 'submit_payment',
                fromStatus: BookingStatus.awaiting_payment,
                toStatus: BookingStatus.payment_submitted,
                actorType: 'system',
                note: 'Stripe payment reported via session refresh',
              },
            });
          }

          const effectiveSettings = await settingsService.getEffectiveCheckoutSettings(booking.items[0]?.hotelId);

          if (effectiveSettings.autoConfirmAfterPayment) {
            await tx.bookingEvent.create({
              data: {
                bookingId: booking.id,
                event: 'verify_payment',
                fromStatus: BookingStatus.payment_submitted,
                toStatus: BookingStatus.payment_verified,
                actorType: 'system',
                note: 'Stripe payment verified via session refresh',
              },
            });
            await tx.bookingEvent.create({
              data: {
                bookingId: booking.id,
                event: 'confirm_booking',
                fromStatus: BookingStatus.payment_verified,
                toStatus: BookingStatus.confirmed,
                actorType: 'system',
                actorId: 'system',
                note: 'Auto-confirmed after payment verification',
              },
            });
            await tx.booking.update({
              where: { id: booking.id },
              data: { status: BookingStatus.confirmed },
            });
          } else {
            await tx.bookingEvent.create({
              data: {
                bookingId: booking.id,
                event: 'verify_payment',
                fromStatus: BookingStatus.payment_submitted,
                toStatus: BookingStatus.payment_verified,
                actorType: 'system',
                note: 'Stripe payment verified via session refresh',
              },
            });
            await tx.booking.update({
              where: { id: booking.id },
              data: { status: BookingStatus.payment_verified },
            });
          }
        }
      });
    }

    const updatedBooking = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: { payments: { orderBy: { submittedAt: 'desc' } } },
    });

    return {
      status: updatedBooking?.status,
      payment_status: updatedBooking?.payments[0]?.status,
      session_status: sessionStatus.status,
    };
  }

  async approveBooking(code: string, actor: { id: string; role: Role | string }, note?: string) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: { items: true },
    });

    if (!booking) {
      throw new NotFoundError(`Booking '${code}' not found`);
    }

    const allowedStatuses: string[] = [
      BookingStatus.requested,
      BookingStatus.checking_availability,
      BookingStatus.awaiting_payment,
      BookingStatus.payment_submitted,
      BookingStatus.payment_verified,
    ];

    if (!allowedStatuses.includes(booking.status)) {
      throw new InvalidTransitionError(`Cannot approve booking in status '${booking.status}'`);
    }

    const actorType = (actor.role || 'agent') as ActorType;
    const hotelId = booking.items[0]?.hotelId;
    const effectiveSettings = await settingsService.getEffectiveCheckoutSettings(hotelId);

    return await prisma.$transaction(async (tx) => {
      if (
        booking.status === BookingStatus.payment_verified ||
        booking.status === BookingStatus.payment_submitted
      ) {
        if (booking.status === BookingStatus.payment_submitted) {
          await tx.bookingEvent.create({
            data: {
              bookingId: booking.id,
              event: 'verify_payment',
              fromStatus: BookingStatus.payment_submitted,
              toStatus: BookingStatus.payment_verified,
              actorType,
              actorId: actor.id,
              note: note || 'Pago verificado durante aprobación',
            },
          });
        }

        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_booking',
            fromStatus:
              booking.status === BookingStatus.payment_submitted
                ? BookingStatus.payment_verified
                : booking.status,
            toStatus: BookingStatus.confirmed,
            actorType,
            actorId: actor.id,
            note: note || 'Reserva aprobada y confirmada',
          },
        });

        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.confirmed,
            slaDueAt: null,
          },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            items: true,
          },
        });

        recordBookingTransition('confirm_booking');
        return updated;
      }

      if (booking.status === BookingStatus.requested) {
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'start_availability_check',
            fromStatus: BookingStatus.requested,
            toStatus: BookingStatus.checking_availability,
            actorType,
            actorId: actor.id,
            note: note || 'Disponibilidad consultada',
          },
        });
      }

      if (booking.paymentMode === 'at_hotel') {
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_pay_at_hotel',
            fromStatus:
              booking.status === BookingStatus.requested
                ? BookingStatus.checking_availability
                : booking.status,
            toStatus: BookingStatus.confirmed,
            actorType,
            actorId: actor.id,
            note: note || 'Disponibilidad confirmada (Pago en hotel)',
          },
        });

        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.confirmed,
            slaDueAt: null,
          },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            items: true,
          },
        });

        recordBookingTransition('confirm_pay_at_hotel');
        return updated;
      } else {
        const windowHours = booking.paymentWindowHours ?? effectiveSettings.paymentWindowHours;
        const slaDueAt = new Date(Date.now() + windowHours * 3600 * 1000);

        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_availability',
            fromStatus:
              booking.status === BookingStatus.requested
                ? BookingStatus.checking_availability
                : booking.status,
            toStatus: BookingStatus.awaiting_payment,
            actorType,
            actorId: actor.id,
            note: note || 'Disponibilidad confirmada',
          },
        });

        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.awaiting_payment,
            slaDueAt,
            paymentWindowHours: windowHours,
          },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            items: true,
          },
        });

        recordBookingTransition('confirm_availability');
        return updated;
      }
    });
  }

  async extendPaymentWindow(
    code: string,
    additionalHours: number,
    note: string,
    actor: { id: string; role: Role | string }
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: { items: true },
    });

    if (!booking) {
      throw new NotFoundError(`Booking '${code}' not found`);
    }

    if (booking.status !== 'awaiting_payment') {
      throw new BadRequestError('Can only extend payment window for bookings in awaiting_payment');
    }

    if (typeof additionalHours !== 'number' || additionalHours <= 0) {
      throw new BadRequestError('additionalHours must be a positive number');
    }

    if (!note || !note.trim()) {
      throw new BadRequestError('A non-empty note is required to extend payment window');
    }

    const hotelId = booking.items[0]?.hotelId;
    const effectiveSettings = await settingsService.getEffectiveCheckoutSettings(hotelId);

    const currentHours = booking.paymentWindowHours ?? effectiveSettings.paymentWindowHours;
    const newHours = currentHours + additionalHours;

    const baseTime = booking.slaDueAt ? booking.slaDueAt.getTime() : Date.now();
    const newSlaDueAt = new Date(baseTime + additionalHours * 3600 * 1000);

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          paymentWindowHours: newHours,
          slaDueAt: newSlaDueAt,
          remindersSent: [],
        },
        include: {
          events: { orderBy: { createdAt: 'desc' } },
        },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: 'extend_payment_window',
          fromStatus: BookingStatus.awaiting_payment,
          toStatus: BookingStatus.awaiting_payment,
          actorType: (actor.role || 'agent') as ActorType,
          actorId: actor.id,
          note: `Extensión de plazo por ${additionalHours}h. Motivo: ${note}`,
        },
      });

      return updated;
    });
  }

  async verifyPayment(
    code: string,
    body: {
      paymentId?: string;
      amountReceived?: number;
      currency?: string;
      note?: string;
    },
    actor: { id: string; role: Role | string }
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: {
        items: true,
        payments: { orderBy: { submittedAt: 'desc' } },
      },
    });

    if (!booking) {
      throw new NotFoundError(`Booking '${code}' not found`);
    }

    if (booking.status !== 'payment_submitted') {
      throw new InvalidTransitionError(`Cannot verify payment for booking in status '${booking.status}'`);
    }

    const payment = body.paymentId
      ? booking.payments.find((p) => p.id === body.paymentId)
      : booking.payments[0];

    if (!payment) {
      throw new NotFoundError('Payment record not found');
    }

    const hotelId = booking.items[0]?.hotelId;
    const effectiveSettings = await settingsService.getEffectiveCheckoutSettings(hotelId);

    return await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'verified',
          verifiedAt: new Date(),
          verifiedBy: actor.id,
          amountReceived: body.amountReceived ?? payment.amountQuoted,
        },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: 'verify_payment',
          fromStatus: BookingStatus.payment_submitted,
          toStatus: BookingStatus.payment_verified,
          actorType: (actor.role || 'agent') as ActorType,
          actorId: actor.id,
          note: body.note || 'Pago verificado',
        },
      });

      if (effectiveSettings.autoConfirmAfterPayment) {
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            event: 'confirm_booking',
            fromStatus: BookingStatus.payment_verified,
            toStatus: BookingStatus.confirmed,
            actorType: 'system',
            actorId: 'system',
            note: 'Confirmación automática de sistema tras verificación de pago',
          },
        });

        return await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.confirmed },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            payments: { orderBy: { submittedAt: 'desc' } },
          },
        });
      } else {
        return await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.payment_verified },
          include: {
            events: { orderBy: { createdAt: 'desc' } },
            payments: { orderBy: { submittedAt: 'desc' } },
          },
        });
      }
    });
  }

  async rejectPayment(
    code: string,
    body: {
      paymentId?: string;
      reason: string;
      notes?: string;
    },
    actor: { id: string; role: Role | string }
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: {
        payments: { orderBy: { submittedAt: 'desc' } },
      },
    });

    if (!booking) {
      throw new NotFoundError(`Booking '${code}' not found`);
    }

    if (booking.status !== 'payment_submitted') {
      throw new InvalidTransitionError(`Cannot reject payment for booking in status '${booking.status}'`);
    }

    const payment = body.paymentId
      ? booking.payments.find((p) => p.id === body.paymentId)
      : booking.payments[0];

    if (!payment) {
      throw new NotFoundError('Payment record not found');
    }

    return await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'rejected',
          rejectionReason: body.reason,
          rejectionNotes: body.notes || null,
        },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: 'reject_payment',
          fromStatus: BookingStatus.payment_submitted,
          toStatus: BookingStatus.awaiting_payment,
          actorType: (actor.role || 'agent') as ActorType,
          actorId: actor.id,
          note: `Pago rechazado: ${body.reason}${body.notes ? ` - ${body.notes}` : ''}`,
        },
      });

      return await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.awaiting_payment },
        include: {
          events: { orderBy: { createdAt: 'desc' } },
          payments: { orderBy: { submittedAt: 'desc' } },
        },
      });
    });
  }

  async checkDuplicateReference(
    method: PaymentMethod,
    reference: string,
    excludeBookingId?: string
  ): Promise<{ isDuplicate: boolean; duplicateBookingCode?: string }> {
    const normalizedTarget = reference.trim().toUpperCase().replace(/[\s\-_]/g, '');
    if (!normalizedTarget) return { isDuplicate: false };

    const payments = await prisma.payment.findMany({
      where: {
        method,
        status: { in: ['submitted', 'verified'] },
        ...(excludeBookingId ? { bookingId: { not: excludeBookingId } } : {}),
      },
      include: {
        booking: { select: { code: true } },
      },
    });

    const match = payments.find(
      (p) => p.reference.trim().toUpperCase().replace(/[\s\-_]/g, '') === normalizedTarget
    );

    if (match) {
      return {
        isDuplicate: true,
        duplicateBookingCode: match.booking.code,
      };
    }

    return { isDuplicate: false };
  }
}

export const bookingService = new BookingService();

