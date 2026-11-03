import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { env } from '../../src/config/env.js';

describe('Observability & Security Headers Integration', () => {
  it('/metrics is disabled (404) when METRICS_TOKEN is unset', async () => {
    const originalToken = env.METRICS_TOKEN;
    (env as any).METRICS_TOKEN = undefined;

    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);

    (env as any).METRICS_TOKEN = originalToken;
  });

  it('/metrics requires bearer METRICS_TOKEN authentication', async () => {
    (env as any).METRICS_TOKEN = 'secret-metrics-token-123';

    // No auth
    const resNoAuth = await request(app).get('/metrics');
    expect(resNoAuth.status).toBe(401);

    // Bad auth
    const resBadAuth = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token');
    expect(resBadAuth.status).toBe(401);

    const { recordBookingTransition } = await import('../../src/lib/metrics.js');
    recordBookingTransition('test_metric_event');

    // Valid auth
    const resValid = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-metrics-token-123');
    expect(resValid.status).toBe(200);
    expect(resValid.headers['content-type']).toContain('text/plain');
    expect(resValid.text).toContain('http_requests_total');
    expect(resValid.text).toContain('fx_rate_age_seconds');
    expect(resValid.text).toContain('booking_transitions_total{event="test_metric_event"}');
  });

  it('sets Cache-Control: no-store, Referrer-Policy: no-referrer, and X-Robots-Tag: noindex, nofollow on /api/v1/bookings/*', async () => {
    const res = await request(app).get('/api/v1/bookings/VH-2026-NONEXISTENT');

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
