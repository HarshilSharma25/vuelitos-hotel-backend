import { PaymentMethod } from '@prisma/client';
import { BadRequestError } from '../../lib/errors.js';

export function validateRefundDestination(
  method: string,
  details: Record<string, unknown>,
  paidMethod?: PaymentMethod | null
): void {
  if (paidMethod === PaymentMethod.stripe_card || method === 'stripe_card' || method === 'card') {
    return;
  }

  const m = method as PaymentMethod;
  switch (m) {
    case PaymentMethod.pago_movil: {
      requireFields(details, ['bank', 'phone', 'id_number']);
      break;
    }
    case PaymentMethod.bs_transfer: {
      requireFields(details, ['bank', 'account_holder', 'account_number']);
      break;
    }
    case PaymentMethod.zelle: {
      if (!details.email && !details.phone) {
        throw new BadRequestError('Zelle requires email or phone');
      }
      requireFields(details, ['holder_name']);
      break;
    }
    case PaymentMethod.usdt_binance: {
      requireFields(details, ['network', 'address']);
      break;
    }
    default:
      throw new BadRequestError('Unsupported refund destination method');
  }
}

function requireFields(obj: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = obj[k];
    if (v == null || String(v).trim() === '') {
      throw new BadRequestError(`Missing destination field: ${k}`);
    }
  }
}
