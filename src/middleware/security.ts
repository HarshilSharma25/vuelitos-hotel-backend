import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export const helmetMiddleware = helmet({
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true,
  },
  xContentTypeOptions: true,
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
});

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

const allowedOriginsList = [
  env.PUBLIC_API_ORIGIN,
  ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
  'http://localhost:5173',
  'http://localhost:5174',
].map(normalizeOrigin);

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOriginsList.includes(normalizeOrigin(origin))) {
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
    'X-Visitor-Id',
    'X-Client-Channel',
    'X-Client-User-Agent',
    'X-Flow-Id',
    'If-None-Match',
  ],
  exposedHeaders: ['Retry-After', 'ETag'],
});

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.headers['x-request-id'] = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
}
