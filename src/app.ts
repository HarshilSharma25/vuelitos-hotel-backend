import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import crypto from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { initSentry } from './lib/sentry.js';
import { getPrometheusMetrics, recordHttpRequest } from './lib/metrics.js';
import {
  corsMiddleware,
  helmetMiddleware,
  requestIdMiddleware,
} from './middleware/security.js';
import { errorHandler } from './middleware/errors.js';
import { ratesRouter } from './modules/rates/routes.js';
import { catalogRouter } from './modules/catalog/routes.js';
import { bookingRouter } from './modules/bookings/routes.js';
import { leadRouter } from './modules/leads/routes.js';
import { quoteRouter } from './modules/quotes/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { internalPaymentsRouter } from './modules/payments/internal.routes.js';
import { NotFoundError } from './lib/errors.js';

initSentry().catch((err) => {
  logger.warn({ err: err.message }, 'Failed to initialize Sentry');
});

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp() {
  const app = express();

  const trustProxyVal = env.TRUST_PROXY;
  if (trustProxyVal === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxyVal === 'false') {
    app.set('trust proxy', false);
  } else if (!isNaN(Number(trustProxyVal))) {
    app.set('trust proxy', Number(trustProxyVal));
  } else {
    app.set('trust proxy', trustProxyVal);
  }

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
      customLogLevel: (_req, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    })
  );
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(cookieParser(env.SESSION_SECRET));
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationSec = (Date.now() - start) / 1000;
      const routePath = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
      recordHttpRequest(req.method, routePath, res.statusCode, durationSec);
    });
    next();
  });

  app.use('/files', express.static(path.resolve(env.FILES_ROOT)));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/booking/payment-status', (req, res) => {
    const code = (req.query.code as string) || '';
    const status = (req.query.status as string) || 'success';
    const token = (req.query.token as string) || '';

    const frontendBase =
      process.env.FRONTEND_URL ||
      'http://localhost:5174';

    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const targetUrl = `${frontendBase.replace(/\/+$/, '')}/booking/payment-status?code=${encodeURIComponent(code)}&status=${encodeURIComponent(status)}${tokenParam}`;

    return res.redirect(302, targetUrl);
  });

  app.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.ping();
      }
      res.json({ status: 'ready', db: 'up', redis: 'up' });
    } catch (err: any) {
      res.status(503).json({ status: 'unready', error: err.message });
    }
  });

  app.get('/metrics', async (req, res) => {
    if (!env.METRICS_TOKEN) {
      return res.status(404).send('Not Found');
    }
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${env.METRICS_TOKEN}`) {
      return res.status(401).send('Unauthorized');
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    const metrics = await getPrometheusMetrics();
    res.send(metrics);
  });

  app.use('/internal', internalPaymentsRouter);

  const v1Router = express.Router();
  v1Router.use(ratesRouter);
  v1Router.use(catalogRouter);
  v1Router.use(bookingRouter);
  v1Router.use(leadRouter);
  v1Router.use(quoteRouter);
  app.use('/api/v1', v1Router);

  app.use('/api/admin', adminRouter);

  app.use((_req, _res, next) => {
    next(new NotFoundError('Endpoint not found'));
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
