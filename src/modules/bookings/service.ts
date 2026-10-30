import { BookingStatus, PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { ratesService } from '../rates/service.js';
import {
  generateAccessToken,
  generateBookingCode,
  verifyAccessToken,
} from '../../lib/ids.js';
import { calculateSlaDueAt, getCaracasWallDate } from '../../lib/caracas-time.js';
import {
  GroupRequestRequiredError,
  InvalidStayWindowError,
  InvalidTransitionError,
  NotFoundError,
  ForbiddenError,
  StayNotBookableError,
} from '../../lib/errors.js';
import {
  parseStayWindow,
  priceStay,
  SeasonInput,
} from '../pricing/index.js';
import { getAllowedActions, transition } from './state-machine.js';

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
    start_check: 'Equipo inició consulta con el hotel',
    hotel_confirmed: 'Hotel confirmó disponibilidad',
    offer_alternatives: 'Se enviaron opciones alternativas',
    accept_alternative: 'Cliente aceptó alternativa',
    mark_unavailable: 'Hotel sin disponibilidad',
    submit_payment: 'Cliente reportó pago',
    verify_payment: 'Pago verificado por el equipo',
    reject_payment: 'Reporte de pago rechazado',
    confirm_booking: 'Reserva confirmada con el hotel',
    expire_payment_window: 'Ventana de pago expirada',
    cancel: 'Solicitud cancelada',
    complete_refund: 'Reembolso completado',
  },
  en: {
    start_request: 'Request created by customer',
    requested: 'Request submitted',
    start_check: 'Team started checking with hotel',
    hotel_confirmed: 'Hotel confirmed availability',
    offer_alternatives: 'Alternative stays offered',
    accept_alternative: 'Customer accepted alternative',
    mark_unavailable: 'Hotel has no availability',
    submit_payment: 'Customer reported payment',
    verify_payment: 'Payment verified by staff',
    reject_payment: 'Payment report rejected',
    confirm_booking: 'Booking confirmed with hotel',
    expire_payment_window: 'Payment window expired',
    cancel: 'Booking cancelled',
    complete_refund: 'Refund completed',
  },
};

export class BookingService {
  async createBooking(body: any, meta: { ip?: string; userId?: string } = {}) {
    // 1. Group threshold check across all items
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

    // 2. Re-price all items server-side
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

      // Use the priced methods
      combinedTotalsByMethod = priced.methods;
    }

    // 3. Calculate SLA due date
    const holidays = await prisma.holiday.findMany({ select: { date: true } });
    const holidayDateStrings = holidays.map((h) => h.date.toISOString().slice(0, 10));
    const now = new Date();
    const slaDueAt = calculateSlaDueAt(now, holidayDateStrings);

    // 4. Generate Access Token & Key
    const { token, accessKey } = generateAccessToken();

    // 5. Atomic single transaction
    const created = await prisma.$transaction(async (tx) => {
      const code = await generateBookingCode(tx);

      const booking = await tx.booking.create({
        data: {
          code,
          status: BookingStatus.requested,
          userId: meta.userId ? String(meta.userId) : null,
          accessKey,
          locale: body.locale || 'es',
          contactName: body.contact.name,
          contactEmail: body.contact.email,
          contactPhone: body.contact.phone || null,
          notes: body.notes || null,
          paymentMethodPref: body.payment_method || null,
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

        // Insert pending availability check
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

      // Insert requested event
      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: 'requested',
          fromStatus: null,
          toStatus: BookingStatus.requested,
          actorType: 'customer',
          actorId: null,
          note: 'Solicitud creada',
        },
      });

      return {
        code: booking.code,
        access_token: token,
        status: 'requested' as const,
        sla_due_at: slaDueAt.toISOString(),
      };
    });

    return created;
  }

  async getBookingView(code: string, token?: string, user?: { id: string; role?: string }) {
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

    // Customer isolation: authenticated users cannot access other customers' bookings
    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }

    const locale = (booking.locale === 'en' ? 'en' : 'es') as 'es' | 'en';
    const statusMeta = STATUS_LABELS[locale][booking.status] || STATUS_LABELS.es[booking.status];

    // Compute payment_due_at if awaiting_payment
    let paymentDueAt: string | null = null;
    if (booking.status === BookingStatus.awaiting_payment) {
      const windowHours = env.PAYMENT_WINDOW_HOURS || 48;
      const dueDate = new Date(booking.updatedAt.getTime() + windowHours * 60 * 60 * 1000);
      paymentDueAt = dueDate.toISOString();
    }

    // Resolve items with hotel and room names
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

    return {
      code: booking.code,
      status: booking.status,
      status_label: statusMeta.label,
      status_description: statusMeta.description,
      sla_due_at: booking.slaDueAt ? booking.slaDueAt.toISOString() : null,
      payment_due_at: paymentDueAt,
      contact: {
        name: booking.contactName,
        email: booking.contactEmail,
      },
      items: itemsFormatted,
      totals_by_method: booking.totalsByMethod as any,
      exchange_snapshot: booking.fxSnapshot as any,
      payments,
      timeline,
      allowed_actions: getAllowedActions(booking.status),
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

    // Customer isolation: authenticated users cannot access other customers' bookings
    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }

    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
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

    // Find quoted amount for method
    const totals = booking.totalsByMethod as any[];
    const methodTotal = totals.find((t) => t.method === body.method);
    const amountQuoted = methodTotal ? methodTotal.amount : 0;
    const currency = methodTotal ? methodTotal.currency : 'USD';

    await prisma.$transaction(async (tx) => {
      // Compare-and-set update
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

    // Customer isolation: authenticated users cannot access other customers' bookings
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

    return this.getBookingView(code, token, user);
  }

  async getCustomerBookings(userId: string) {
    const bookings = await prisma.booking.findMany({
      where: { userId: String(userId) },
      orderBy: { createdAt: 'desc' },
      include: {
        items: true,
      },
    });

    return bookings.map((b) => ({
      id: b.id,
      code: b.code,
      status: b.status,
      created_at: b.createdAt.toISOString(),
      totals_by_method: b.totalsByMethod,
      items: b.items.map((it) => ({
        id: it.id,
        hotel_id: it.hotelId,
        check_in: it.checkIn.toISOString().slice(0, 10),
        check_out: it.checkOut.toISOString().slice(0, 10),
        meal_plan: it.mealPlan,
      })),
    }));
  }
}

export const bookingService = new BookingService();
