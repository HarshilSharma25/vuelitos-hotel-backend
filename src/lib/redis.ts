import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

if (process.env.NODE_ENV !== 'test') {
  redis.connect().catch((err: any) => {
    logger.error({ err }, 'Failed to connect to Redis');
  });
}
