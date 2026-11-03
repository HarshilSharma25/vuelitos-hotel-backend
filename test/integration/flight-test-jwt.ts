import fs from 'node:fs';
import path from 'node:path';
import * as jose from 'jose';
import { setPublicKeyOverride } from '../../src/lib/jwt.js';

export async function loadFlightTestPrivateKey(): Promise<jose.KeyLike> {
  if (process.env.HOTEL_TEST_USE_FLIGHT_KEY === '1') {
    const privPem = fs.readFileSync(
      path.resolve('../Flight-Booking-Backend/certs/jwt-private.pem'),
      'utf8'
    );
    return jose.importPKCS8(privPem, 'RS256');
  }

  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  setPublicKeyOverride(publicKey);
  return privateKey;
}
