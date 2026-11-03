import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { decodePdfBase64Field } from './pdf-payload-decode.js';

export interface CreateFlightStripeSessionInput {
  hotel_booking_code: string;
  amount_cents: number;
  currency: string;
  customer_email?: string;
  success_url: string;
  cancel_url: string;
  idempotency_key: string;
}

export interface FlightStripeSessionOutput {
  session_id: string;
  checkout_url: string;
  expires_at: number;
}

export interface FlightStripeSessionStatusOutput {
  session_id: string;
  status: string;
  payment_status: string;
  amount_total: number;
  currency: string;
  expires_at?: number;
  metadata?: Record<string, any>;
}

export class FlightInternalClient {
  private baseUrl: string;
  private secret: string;

  constructor(baseUrl?: string, secret?: string) {
    this.baseUrl = baseUrl || env.FLIGHT_INTERNAL_URL || 'http://127.0.0.1:8081';
    this.secret = secret || env.INTERNAL_SERVICE_SECRET;
  }

  private signRequest(body?: unknown): { timestamp: string; signature: string; rawBody: string } {
    const timestamp = Date.now().toString();
    const rawBody = body !== undefined && body !== null ? JSON.stringify(body) : '';
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    return { timestamp, signature, rawBody };
  }

  private async requestWithRetry<T>(config: {
    method: 'GET' | 'POST';
    url: string;
    data?: unknown;
    timeout?: number;
  }): Promise<T> {
    const { timestamp, signature, rawBody } = this.signRequest(config.data);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    };

    const timeoutMs = config.timeout || 5000;

    const makeCall = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${config.url}`, {
          method: config.method,
          headers,
          body: config.method === 'POST' ? rawBody : undefined,
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text();
          const error: any = new Error(`Flight internal error: ${res.status} ${errText}`);
          error.status = res.status;
          throw error;
        }

        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await makeCall();
    } catch (err: any) {
      const isNetworkError =
        err.name === 'AbortError' ||
        err.name === 'TypeError' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        !err.status;

      if (isNetworkError) {
        await new Promise((r) => setTimeout(r, 100));
        return await makeCall();
      }

      throw err;
    }
  }

  async createCheckoutSession(params: CreateFlightStripeSessionInput): Promise<FlightStripeSessionOutput> {
    return this.requestWithRetry<FlightStripeSessionOutput>({
      method: 'POST',
      url: '/internal/hotel-payments/sessions',
      data: params,
    });
  }

  async getSessionStatus(sessionId: string): Promise<FlightStripeSessionStatusOutput> {
    return this.requestWithRetry<FlightStripeSessionStatusOutput>({
      method: 'GET',
      url: `/internal/hotel-payments/sessions/${sessionId}`,
    });
  }

  async sendHotelMail(body: {
    template: string;
    recipient: string;
    locale: string;
    data: Record<string, unknown>;
    attach_confirmation_pdf?: boolean;
  }): Promise<{ ok: boolean }> {
    return this.requestWithRetry<{ ok: boolean }>({
      method: 'POST',
      url: '/internal/hotel-mail/send',
      data: body,
      timeout: 15000,
    });
  }

  async fetchConfirmationPdf(bookingData: Record<string, unknown>): Promise<Buffer> {
    const res = await this.requestWithRetry<{ pdf_base64: string }>({
      method: 'POST',
      url: '/internal/hotel-documents/confirmation',
      data: { booking: bookingData },
      timeout: 30000,
    });
    return decodePdfBase64Field(res.pdf_base64);
  }
}

export const flightInternalClient = new FlightInternalClient();
