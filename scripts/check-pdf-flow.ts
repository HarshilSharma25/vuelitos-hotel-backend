import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from '../src/config/env.js';
import { buildBookingMailPayload } from '../src/lib/booking-mail-data.js';
import { decodePdfBase64Field } from '../src/lib/pdf-payload-decode.js';

async function main() {
  const code = process.argv[2] || 'VH-2026-000606';
  const payload = await buildBookingMailPayload(code);
  const body = { booking: payload };
  const rawBody = JSON.stringify(body);
  const ts = Date.now().toString();
  const sig = crypto
    .createHmac('sha256', env.INTERNAL_SERVICE_SECRET)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  const res = await fetch(`${env.FLIGHT_INTERNAL_URL}/internal/hotel-documents/confirmation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Signature': sig,
    },
    body: rawBody,
  });
  const json = (await res.json()) as { pdf_base64?: string; error?: string };
  console.log('flight status', res.status);
  console.log('b64 prefix', json.pdf_base64?.slice(0, 24));
  const pdf = decodePdfBase64Field(json.pdf_base64 || '');
  const hex = pdf.subarray(0, 8).toString('hex');
  console.log('pdf length', pdf.length, 'magic hex', hex);
  fs.writeFileSync('/tmp/vuelitos-test.pdf', pdf);
  console.log('wrote /tmp/vuelitos-test.pdf');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
