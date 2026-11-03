import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { redis } from '../../src/lib/redis.js';
import { env } from '../../src/config/env.js';

describe('Rate Limiter IP Trust Integration Tests', () => {
  beforeAll(async () => {
    if (redis.status !== 'ready' && redis.status !== 'connect') {
      try {
        await redis.connect();
      } catch (err) {
        // Redis connection error
      }
    }
  });

  beforeEach(async () => {
    // Clear redis keys for leads bucket if redis connected
    if (redis.status === 'ready' || redis.status === 'connect') {
      const keys = await redis.keys('ratelimit:leads-create:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  });

  it('spoofed X-Forwarded-For headers do not bypass limits', async () => {
    // Limit for leads is 10 per 10 min
    const responses: number[] = [];

    for (let i = 0; i < 12; i++) {
      // Attacker tries to bypass rate limiting by cycling X-Forwarded-For IPs
      const fakeIp = `198.51.100.${i + 1}`;
      const res = await request(app)
        .post('/api/v1/leads')
        .set('X-Forwarded-For', `${fakeIp}, 127.0.0.1`)
        .send({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          message: 'Rate limit test message',
        });
      responses.push(res.status);
    }

    // The first 10 should succeed (201)
    const successCount = responses.filter((s) => s === 201).length;
    // Requests beyond 10 should be rate-limited (429)
    const rateLimitedCount = responses.filter((s) => s === 429).length;

    expect(successCount).toBe(10);
    expect(rateLimitedCount).toBeGreaterThanOrEqual(1);
  });

  it('honors CF-Connecting-IP only when TRUST_CF_CONNECTING_IP=true', async () => {
    (env as any).TRUST_CF_CONNECTING_IP = true;

    // Send 10 requests under IP A
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/v1/leads')
        .set('CF-Connecting-IP', '203.0.113.88')
        .send({
          name: `User CF ${i}`,
          email: `usercf${i}@example.com`,
        });
      expect(res.status).toBe(201);
    }

    // 11th request under IP A should be rate limited
    const resA = await request(app)
      .post('/api/v1/leads')
      .set('CF-Connecting-IP', '203.0.113.88')
      .send({
        name: 'User CF Over',
        email: 'usercfover@example.com',
      });
    expect(resA.status).toBe(429);

    // Request from different CF-Connecting-IP IP B should succeed
    const resB = await request(app)
      .post('/api/v1/leads')
      .set('CF-Connecting-IP', '203.0.113.99')
      .send({
        name: 'User CF B',
        email: 'usercfb@example.com',
      });
    expect(resB.status).toBe(201);

    (env as any).TRUST_CF_CONNECTING_IP = false;
  });
});
