import { Request, Response, NextFunction } from 'express';
import { redis } from '../lib/redis.js';
import { RateLimitedError } from '../lib/errors.js';

export interface RateLimitOptions {
  bucket: string;
  max: number;
  windowSec: number;
  keyGenerator?: (req: Request) => string;
}

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local current = redis.call('INCR', key)
if current == 1 then
    redis.call('EXPIRE', key, tonumber(ARGV[2]))
end
return current
`;

export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientIp =
        (req.headers['cf-connecting-ip'] as string) ||
        (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
        req.ip ||
        '127.0.0.1';

      const keyPart = options.keyGenerator ? options.keyGenerator(req) : clientIp;
      const redisKey = `ratelimit:${options.bucket}:${keyPart}`;

      if (redis.status !== 'ready' && redis.status !== 'connect') {
        // If redis is not ready, proceed in test/dev
        return next();
      }

      const count = (await redis.eval(
        RATE_LIMIT_LUA,
        1,
        redisKey,
        options.max,
        options.windowSec
      )) as number;

      if (count > options.max) {
        const ttl = await redis.ttl(redisKey);
        const retryAfter = ttl > 0 ? ttl : options.windowSec;
        res.setHeader('Retry-After', retryAfter);
        return next(new RateLimitedError(retryAfter));
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return next(err);
      }
      // If Redis has an issue, do not block the user unless necessary
      console.warn('Rate limiter error, skipping limit check:', err);
      next();
    }
  };
}
