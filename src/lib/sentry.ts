import { env } from '../config/env.js';
import { logger } from './logger.js';

let sentryClient: any = null;

export async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN) {
    return;
  }
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
    });
    sentryClient = Sentry;
    logger.info('Sentry initialized successfully');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Sentry requested via SENTRY_DSN but @sentry/node not available');
  }
}

export function captureException(err: unknown, context?: Record<string, any>): void {
  if (sentryClient) {
    try {
      sentryClient.captureException(err, { extra: context });
    } catch {
    }
  }
}

export function captureMessage(message: string, context?: Record<string, any>): void {
  if (sentryClient) {
    try {
      sentryClient.captureMessage(message, { extra: context });
    } catch {
    }
  }
}
