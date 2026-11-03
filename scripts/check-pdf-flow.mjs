import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildBookingMailPayload } from '../dist/src/lib/booking-mail-data.js';

// Use tsx-friendly: run via npx tsx scripts/check-pdf-flow.ts instead if dist missing
