import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export const helmetMiddleware = helmet({
  hsts: {
    maxAge: 63072000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
  xContentTypeOptions: true,
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
});

const allowedOriginsList = [
  env.PUBLIC_API_ORIGIN,
  ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
  'http://localhost:5173',
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOriginsList.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Booking-Token',
    'X-Request-Id',
    'Accept-Language',
  ],
  exposedHeaders: ['Retry-After'],
});

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.headers['x-request-id'] = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
}
