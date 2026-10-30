import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

// Ensure graceful connection
if (process.env.NODE_ENV !== 'test') {
  redis.connect().catch((err: any) => {
    console.error('Failed to connect to Redis:', err);
  });
}
