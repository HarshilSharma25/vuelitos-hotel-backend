import { describe, it, expect } from 'vitest';
import {
  generateAccessToken,
  verifyAccessToken,
  hashTokenToAccessKey,
} from '../../src/lib/ids.js';

describe('Access Token & Constant-time verification', () => {
  it('generates base64url token and 128-bit uuid accessKey', () => {
    const { token, accessKey } = generateAccessToken();
    expect(token).toBeTruthy();
    expect(accessKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Matches hash
    expect(hashTokenToAccessKey(token)).toBe(accessKey);

    // Constant-time verify
    expect(verifyAccessToken(token, accessKey)).toBe(true);
  });

  it('rejects invalid or tampered tokens safely', () => {
    const { token, accessKey } = generateAccessToken();
    expect(verifyAccessToken('wrong-token', accessKey)).toBe(false);
    expect(verifyAccessToken(token + 'extra', accessKey)).toBe(false);
    expect(verifyAccessToken('', accessKey)).toBe(false);
  });
});
