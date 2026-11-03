import { prisma } from './prisma.js';

interface CounterMap {
  [key: string]: number;
}

const httpRequests: CounterMap = {};
const httpDurations: Record<string, { count: number; sum: number }> = {};
const bookingTransitions: CounterMap = {};

export function recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
  const normalizedRoute = route.replace(/\/[0-9a-fA-F-]{36}/g, '/:id').replace(/\/VH-[0-9]{4}-[0-9]+/g, '/:code');
  const key = `method="${method}",route="${normalizedRoute}",status="${status}"`;
  httpRequests[key] = (httpRequests[key] || 0) + 1;

  if (!httpDurations[key]) {
    httpDurations[key] = { count: 0, sum: 0 };
  }
  httpDurations[key].count += 1;
  httpDurations[key].sum += durationSeconds;
}

export function recordBookingTransition(event: string): void {
  const key = `event="${event}"`;
  bookingTransitions[key] = (bookingTransitions[key] || 0) + 1;
}

export async function getPrometheusMetrics(): Promise<string> {
  const lines: string[] = [];

  lines.push('# HELP http_requests_total Total HTTP requests handled');
  lines.push('# TYPE http_requests_total counter');
  for (const [labels, count] of Object.entries(httpRequests)) {
    lines.push(`http_requests_total{${labels}} ${count}`);
  }

  lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds');
  lines.push('# TYPE http_request_duration_seconds summary');
  for (const [labels, data] of Object.entries(httpDurations)) {
    lines.push(`http_request_duration_seconds_count{${labels}} ${data.count}`);
    lines.push(`http_request_duration_seconds_sum{${labels}} ${data.sum.toFixed(4)}`);
  }

  lines.push('# HELP booking_transitions_total Booking state machine transitions by event');
  lines.push('# TYPE booking_transitions_total counter');
  for (const [labels, count] of Object.entries(bookingTransitions)) {
    lines.push(`booking_transitions_total{${labels}} ${count}`);
  }

  lines.push('# HELP fx_rate_age_seconds Age of the latest FX exchange rate in seconds');
  lines.push('# TYPE fx_rate_age_seconds gauge');
  try {
    const latestFx = await prisma.exchangeRate.findFirst({
      orderBy: { recordedAt: 'desc' },
    });
    if (latestFx) {
      const ageSeconds = Math.max(0, Math.floor((Date.now() - latestFx.recordedAt.getTime()) / 1000));
      lines.push(`fx_rate_age_seconds ${ageSeconds}`);
    } else {
      lines.push('fx_rate_age_seconds 0');
    }
  } catch {
    lines.push('fx_rate_age_seconds 0');
  }

  lines.push('');
  return lines.join('\n');
}
