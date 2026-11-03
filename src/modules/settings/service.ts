import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import type { CheckoutSettings } from '@prisma/client';

export interface EffectiveCheckoutSettings {
  payNowEnabled: boolean;
  payAtHotelEnabled: boolean;
  cardPaymentsEnabled: boolean;
  paymentWindowHours: number;
  reminderOffsetsPct: number[];
  autoConfirmAfterPayment: boolean;
}

export interface HotelCheckoutOverrides {
  payNowEnabled: boolean | null;
  payAtHotelEnabled: boolean | null;
  paymentWindowHours: number | null;
  reminderOffsetsPct: number[] | null;
  autoConfirmAfterPayment: boolean | null;
}

export class SettingsService {
  private static readonly GLOBAL_CACHE_KEY = 'checkout_settings:global';
  private static readonly HOTEL_CACHE_PREFIX = 'checkout_settings:hotel:';
  private static readonly CACHE_TTL_SEC = 3600;

  async getGlobalCheckoutSettings(): Promise<CheckoutSettings> {
    let settings = await prisma.checkoutSettings.findUnique({
      where: { id: 'global' },
    });

    if (!settings) {
      settings = await prisma.checkoutSettings.create({
        data: {
          id: 'global',
          payNowEnabled: true,
          payAtHotelEnabled: true,
          cardPaymentsEnabled: true,
          paymentWindowHours: 48,
          reminderOffsetsPct: [50, 90],
          autoConfirmAfterPayment: false,
        },
      });
    }

    return settings;
  }

  async getEffectiveCheckoutSettings(hotelId?: string): Promise<EffectiveCheckoutSettings> {
    const cacheKey = hotelId
      ? `${SettingsService.HOTEL_CACHE_PREFIX}${hotelId}`
      : SettingsService.GLOBAL_CACHE_KEY;

    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, cacheKey }, 'Failed to read checkout settings from Redis cache');
    }

    const global = await this.getGlobalCheckoutSettings();

    let effective: EffectiveCheckoutSettings;

    if (!hotelId) {
      effective = {
        payNowEnabled: global.payNowEnabled,
        payAtHotelEnabled: global.payAtHotelEnabled,
        cardPaymentsEnabled: global.cardPaymentsEnabled,
        paymentWindowHours: global.paymentWindowHours,
        reminderOffsetsPct: global.reminderOffsetsPct,
        autoConfirmAfterPayment: global.autoConfirmAfterPayment,
      };
    } else {
      const hotel = await prisma.hotel.findUnique({
        where: { id: hotelId },
        select: {
          payNowEnabled: true,
          payAtHotelEnabled: true,
          paymentWindowHours: true,
          reminderOffsetsPct: true,
          autoConfirmAfterPayment: true,
        },
      });

      if (!hotel) {
        effective = {
          payNowEnabled: global.payNowEnabled,
          payAtHotelEnabled: global.payAtHotelEnabled,
          cardPaymentsEnabled: global.cardPaymentsEnabled,
          paymentWindowHours: global.paymentWindowHours,
          reminderOffsetsPct: global.reminderOffsetsPct,
          autoConfirmAfterPayment: global.autoConfirmAfterPayment,
        };
      } else {
        const payNowEnabled =
          hotel.payNowEnabled !== null && hotel.payNowEnabled !== undefined
            ? hotel.payNowEnabled
            : global.payNowEnabled;

        const payAtHotelEnabled =
          hotel.payAtHotelEnabled !== null && hotel.payAtHotelEnabled !== undefined
            ? hotel.payAtHotelEnabled
            : global.payAtHotelEnabled;

        const paymentWindowHours =
          hotel.paymentWindowHours !== null && hotel.paymentWindowHours !== undefined
            ? hotel.paymentWindowHours
            : global.paymentWindowHours;

        let reminderOffsetsPct = global.reminderOffsetsPct;
        if (hotel.reminderOffsetsPct && Array.isArray(hotel.reminderOffsetsPct)) {
          reminderOffsetsPct = hotel.reminderOffsetsPct as number[];
        }

        const autoConfirmAfterPayment =
          hotel.autoConfirmAfterPayment !== null && hotel.autoConfirmAfterPayment !== undefined
            ? hotel.autoConfirmAfterPayment
            : global.autoConfirmAfterPayment;

        effective = {
          payNowEnabled,
          payAtHotelEnabled,
          cardPaymentsEnabled: global.cardPaymentsEnabled,
          paymentWindowHours,
          reminderOffsetsPct,
          autoConfirmAfterPayment,
        };
      }
    }

    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.set(cacheKey, JSON.stringify(effective), 'EX', SettingsService.CACHE_TTL_SEC);
      }
    } catch (err: any) {
      logger.warn({ err: err.message, cacheKey }, 'Failed to write checkout settings to Redis cache');
    }

    return effective;
  }

  async updateGlobalCheckoutSettings(
    data: {
      payNowEnabled?: boolean;
      payAtHotelEnabled?: boolean;
      cardPaymentsEnabled?: boolean;
      paymentWindowHours?: number;
      reminderOffsetsPct?: number[];
      autoConfirmAfterPayment?: boolean;
    },
    actor: { id: string; type: string }
  ): Promise<CheckoutSettings> {
    const current = await this.getGlobalCheckoutSettings();

    const newPayNow = data.payNowEnabled ?? current.payNowEnabled;
    const newPayAtHotel = data.payAtHotelEnabled ?? current.payAtHotelEnabled;

    if (!newPayNow && !newPayAtHotel) {
      throw new BadRequestError('At least one of Pay Now or Pay at Hotel must be enabled');
    }

    if (data.paymentWindowHours !== undefined) {
      if (data.paymentWindowHours < 1 || data.paymentWindowHours > 168) {
        throw new BadRequestError('Payment window must be between 1 and 168 hours');
      }
    }

    if (data.reminderOffsetsPct !== undefined) {
      if (
        !Array.isArray(data.reminderOffsetsPct) ||
        data.reminderOffsetsPct.some((pct) => typeof pct !== 'number' || pct <= 0 || pct >= 100)
      ) {
        throw new BadRequestError('Reminder offsets must be an array of percentages between 1 and 99');
      }
    }

    const updated = await prisma.checkoutSettings.update({
      where: { id: 'global' },
      data: {
        payNowEnabled: data.payNowEnabled !== undefined ? data.payNowEnabled : current.payNowEnabled,
        payAtHotelEnabled:
          data.payAtHotelEnabled !== undefined ? data.payAtHotelEnabled : current.payAtHotelEnabled,
        cardPaymentsEnabled:
          data.cardPaymentsEnabled !== undefined ? data.cardPaymentsEnabled : current.cardPaymentsEnabled,
        paymentWindowHours:
          data.paymentWindowHours !== undefined ? data.paymentWindowHours : current.paymentWindowHours,
        reminderOffsetsPct:
          data.reminderOffsetsPct !== undefined ? data.reminderOffsetsPct : current.reminderOffsetsPct,
        autoConfirmAfterPayment:
          data.autoConfirmAfterPayment !== undefined
            ? data.autoConfirmAfterPayment
            : current.autoConfirmAfterPayment,
      },
    });

    await prisma.settingsAudit.create({
      data: {
        settingType: 'checkout_global',
        targetId: null,
        oldValue: {
          payNowEnabled: current.payNowEnabled,
          payAtHotelEnabled: current.payAtHotelEnabled,
          cardPaymentsEnabled: current.cardPaymentsEnabled,
          paymentWindowHours: current.paymentWindowHours,
          reminderOffsetsPct: current.reminderOffsetsPct,
          autoConfirmAfterPayment: current.autoConfirmAfterPayment,
        },
        newValue: {
          payNowEnabled: updated.payNowEnabled,
          payAtHotelEnabled: updated.payAtHotelEnabled,
          cardPaymentsEnabled: updated.cardPaymentsEnabled,
          paymentWindowHours: updated.paymentWindowHours,
          reminderOffsetsPct: updated.reminderOffsetsPct,
          autoConfirmAfterPayment: updated.autoConfirmAfterPayment,
        },
        actorId: actor.id,
        actorType: actor.type,
      },
    });

    await this.invalidateAllCheckoutCache();

    return updated;
  }

  async getHotelCheckoutOptions(hotelId: string): Promise<{
    overrides: HotelCheckoutOverrides;
    effective: EffectiveCheckoutSettings;
  }> {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: {
        id: true,
        payNowEnabled: true,
        payAtHotelEnabled: true,
        paymentWindowHours: true,
        reminderOffsetsPct: true,
        autoConfirmAfterPayment: true,
      },
    });

    if (!hotel) {
      throw new NotFoundError('Hotel not found');
    }

    const effective = await this.getEffectiveCheckoutSettings(hotelId);

    const overrides: HotelCheckoutOverrides = {
      payNowEnabled: hotel.payNowEnabled,
      payAtHotelEnabled: hotel.payAtHotelEnabled,
      paymentWindowHours: hotel.paymentWindowHours,
      reminderOffsetsPct: Array.isArray(hotel.reminderOffsetsPct)
        ? (hotel.reminderOffsetsPct as number[])
        : null,
      autoConfirmAfterPayment: hotel.autoConfirmAfterPayment,
    };

    return { overrides, effective };
  }

  async updateHotelCheckoutOptions(
    hotelId: string,
    data: {
      payNowEnabled?: boolean | null;
      payAtHotelEnabled?: boolean | null;
      paymentWindowHours?: number | null;
      reminderOffsetsPct?: number[] | null;
      autoConfirmAfterPayment?: boolean | null;
    },
    actor: { id: string; type: string }
  ) {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
    });

    if (!hotel) {
      throw new NotFoundError('Hotel not found');
    }

    const global = await this.getGlobalCheckoutSettings();

    const effectivePayNow =
      data.payNowEnabled !== undefined
        ? (data.payNowEnabled ?? global.payNowEnabled)
        : (hotel.payNowEnabled ?? global.payNowEnabled);

    const effectivePayAtHotel =
      data.payAtHotelEnabled !== undefined
        ? (data.payAtHotelEnabled ?? global.payAtHotelEnabled)
        : (hotel.payAtHotelEnabled ?? global.payAtHotelEnabled);

    if (!effectivePayNow && !effectivePayAtHotel) {
      throw new BadRequestError('Hotel settings cannot disable both Pay Now and Pay at Hotel');
    }

    if (data.paymentWindowHours !== undefined && data.paymentWindowHours !== null) {
      if (data.paymentWindowHours < 1 || data.paymentWindowHours > 168) {
        throw new BadRequestError('Payment window must be between 1 and 168 hours');
      }
    }

    if (data.reminderOffsetsPct !== undefined && data.reminderOffsetsPct !== null) {
      if (
        !Array.isArray(data.reminderOffsetsPct) ||
        data.reminderOffsetsPct.some((pct) => typeof pct !== 'number' || pct <= 0 || pct >= 100)
      ) {
        throw new BadRequestError('Reminder offsets must be an array of percentages between 1 and 99');
      }
    }

    const oldValues: HotelCheckoutOverrides = {
      payNowEnabled: hotel.payNowEnabled,
      payAtHotelEnabled: hotel.payAtHotelEnabled,
      paymentWindowHours: hotel.paymentWindowHours,
      reminderOffsetsPct: Array.isArray(hotel.reminderOffsetsPct)
        ? (hotel.reminderOffsetsPct as number[])
        : null,
      autoConfirmAfterPayment: hotel.autoConfirmAfterPayment,
    };

    const updateData: any = {};
    if (data.payNowEnabled !== undefined) updateData.payNowEnabled = data.payNowEnabled;
    if (data.payAtHotelEnabled !== undefined) updateData.payAtHotelEnabled = data.payAtHotelEnabled;
    if (data.paymentWindowHours !== undefined) updateData.paymentWindowHours = data.paymentWindowHours;
    if (data.reminderOffsetsPct !== undefined) updateData.reminderOffsetsPct = data.reminderOffsetsPct;
    if (data.autoConfirmAfterPayment !== undefined)
      updateData.autoConfirmAfterPayment = data.autoConfirmAfterPayment;

    const updatedHotel = await prisma.hotel.update({
      where: { id: hotelId },
      data: updateData,
    });

    const newValues: HotelCheckoutOverrides = {
      payNowEnabled: updatedHotel.payNowEnabled,
      payAtHotelEnabled: updatedHotel.payAtHotelEnabled,
      paymentWindowHours: updatedHotel.paymentWindowHours,
      reminderOffsetsPct: Array.isArray(updatedHotel.reminderOffsetsPct)
        ? (updatedHotel.reminderOffsetsPct as number[])
        : null,
      autoConfirmAfterPayment: updatedHotel.autoConfirmAfterPayment,
    };

    await prisma.settingsAudit.create({
      data: {
        settingType: 'hotel_checkout_options',
        targetId: hotelId,
        oldValue: oldValues as any,
        newValue: newValues as any,
        actorId: actor.id,
        actorType: actor.type,
      },
    });

    await this.invalidateHotelCheckoutCache(hotelId);

    const effective = await this.getEffectiveCheckoutSettings(hotelId);
    return { overrides: newValues, effective };
  }

  async getSettingsAudit(params: {
    settingType?: string;
    targetId?: string;
    limit?: number;
  }) {
    const where: any = {};
    if (params.settingType) where.settingType = params.settingType;
    if (params.targetId !== undefined) where.targetId = params.targetId;

    return prisma.settingsAudit.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: Math.min(params.limit || 50, 100),
    });
  }

  async isStripeCardAvailable(hotelId: string): Promise<boolean> {
    if (!env.INTERNAL_SERVICE_SECRET || !env.FLIGHT_INTERNAL_URL) {
      return false;
    }

    const global = await this.getGlobalCheckoutSettings();
    if (!global.cardPaymentsEnabled) {
      return false;
    }

    const cardRule = await prisma.hotelPaymentTaxRule.findUnique({
      where: {
        hotelId_method: {
          hotelId,
          method: 'stripe_card',
        },
      },
    });

    return !!cardRule;
  }

  private async invalidateAllCheckoutCache() {
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.del(SettingsService.GLOBAL_CACHE_KEY);
        const keys = await redis.keys(`${SettingsService.HOTEL_CACHE_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to clear checkout Redis cache');
    }
  }

  private async invalidateHotelCheckoutCache(hotelId: string) {
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.del(`${SettingsService.HOTEL_CACHE_PREFIX}${hotelId}`);
      }
    } catch (err: any) {
      logger.warn({ err: err.message, hotelId }, 'Failed to clear hotel checkout Redis cache');
    }
  }
}

export const settingsService = new SettingsService();
