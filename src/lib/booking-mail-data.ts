import { prisma } from './prisma.js';
import { derivePaymentStatus } from './payment-status.js';
import { env } from '../config/env.js';
import { NotFoundError } from './errors.js';
import { STATUS_LABELS } from '../modules/bookings/service.js';

function summarizeRoomSelections(
  selections: unknown,
  locale: 'en' | 'es'
): string | undefined {
  if (!Array.isArray(selections) || selections.length === 0) return undefined;
  let adults = 0;
  let children = 0;
  for (const raw of selections) {
    const row = raw as Record<string, unknown>;
    adults += Number(row.adults ?? row.adults_count ?? 0) || 0;
    children += Number(row.children ?? row.children_count ?? 0) || 0;
  }
  const rooms = selections.length;
  if (locale === 'es') {
    const roomWord = rooms === 1 ? 'habitación' : 'habitaciones';
    const parts = [`${rooms} ${roomWord}`, `${adults} adulto${adults === 1 ? '' : 's'}`];
    if (children > 0) parts.push(`${children} niño${children === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }
  const roomWord = rooms === 1 ? 'room' : 'rooms';
  const parts = [`${rooms} ${roomWord}`, `${adults} adult${adults === 1 ? '' : 's'}`];
  if (children > 0) parts.push(`${children} child${children === 1 ? '' : 'ren'}`);
  return parts.join(' · ');
}

export async function buildBookingMailPayload(code: string, accessToken?: string) {
  const booking = await prisma.booking.findUnique({
    where: { code },
    include: {
      items: true,
      payments: { orderBy: { submittedAt: 'desc' } },
    },
  });
  if (!booking) throw new NotFoundError('Booking not found');

  const locale = (booking.locale === 'en' ? 'en' : 'es') as 'es' | 'en';
  const statusMeta = STATUS_LABELS[locale][booking.status];

  const hotel = await prisma.hotel.findUnique({ where: { id: booking.items[0]?.hotelId } });

  const items = booking.items.map((it) => {
    const nights = Math.round(
      (it.checkOut.getTime() - it.checkIn.getTime()) / (1000 * 60 * 60 * 24)
    );
    const snap = it.priceSnapshot as any;
    return {
      check_in: it.checkIn.toISOString().slice(0, 10),
      check_out: it.checkOut.toISOString().slice(0, 10),
      nights,
      meal_plan: it.mealPlan,
      room_selections: it.roomSelections,
      room_summary: summarizeRoomSelections(it.roomSelections, locale),
      price: snap?.total,
    };
  });

  const paymentStatus = derivePaymentStatus({
    status: booking.status,
    paymentMode: booking.paymentMode,
  });

  const websiteBase = env.WEBSITE_URL.replace(/\/+$/, '');
  let viewUrl: string;
  if (booking.userId) {
    viewUrl = `${websiteBase}/${locale === 'en' ? 'en/' : ''}profile/hotel-bookings/${encodeURIComponent(code)}`;
  } else if (accessToken) {
    viewUrl = `${websiteBase}/${locale === 'en' ? 'en/' : ''}reserva/${encodeURIComponent(code)}?token=${encodeURIComponent(accessToken)}`;
  } else {
    viewUrl = `${websiteBase}/${locale === 'en' ? 'en/' : ''}reserva/${encodeURIComponent(code)}`;
  }

  return {
    code: booking.code,
    created_at: booking.createdAt.toISOString(),
    locale,
    status: booking.status,
    status_label: statusMeta.label,
    status_description: statusMeta.description,
    payment_status: paymentStatus,
    payment_mode: booking.paymentMode,
    sla_due_at: booking.slaDueAt?.toISOString() ?? null,
    hotel: {
      name: hotel?.name ?? '',
      destination: hotel?.destination ?? '',
      slug: hotel?.slug ?? '',
    },
    contact: { name: booking.contactName, email: booking.contactEmail },
    items,
    totals_by_method: booking.totalsByMethod,
    fx_snapshot: booking.fxSnapshot,
    payments: booking.payments.map((p) => ({
      method: p.method,
      currency: p.currency,
      amount: Number(p.amountQuoted),
      status: p.status,
      reference: p.reference,
    })),
    view_url: viewUrl,
  };
}
