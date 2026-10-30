import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
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
import { adminRouter } from './modules/admin/routes.js';
import { NotFoundError } from './lib/errors.js';

// Ensure BigInt serializes cleanly to JSON string across all endpoints
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function createApp() {
  const app = express();

  // Trust proxy for Cloudflare Tunnel
  app.set('trust proxy', 1);

  // Security and utilities
  app.use(requestIdMiddleware);
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(cookieParser(env.SESSION_SECRET));
  app.use(express.json({ limit: '2mb' }));

  // Static uploads (for local disk storage driver)
  app.use('/files', express.static(path.resolve(env.FILES_ROOT)));

  // Health and readiness probes
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
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

  // Public API v1
  const v1Router = express.Router();
  v1Router.use(ratesRouter);
  v1Router.use(catalogRouter);
  v1Router.use(bookingRouter);
  v1Router.use(leadRouter);
  app.use('/api/v1', v1Router);

  // Admin API
  app.use('/api/admin', adminRouter);

  // 404 for unknown routes
  app.use((_req, _res, next) => {
    next(new NotFoundError('Endpoint not found'));
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
