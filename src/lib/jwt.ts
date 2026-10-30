import * as jose from 'jose';
import type { KeyInput } from 'jose';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { UnauthenticatedError } from './errors.js';

export interface VerifiedUserIdentity {
  id: string;
  sub: string;
  email?: string;
  role: string;
  roleId?: string;
  userType?: string;
  tokenType: string;
  rawPayload: Record<string, any>;
}

let cachedPublicKey: KeyInput | null = null;

async function getPublicKey(): Promise<KeyInput | null> {
  if (cachedPublicKey) return cachedPublicKey;

  let pem: string | null = null;
  if (env.JWT_PUBLIC_KEY) {
    pem = env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  } else if (env.JWT_PUBLIC_KEY_PATH && fs.existsSync(env.JWT_PUBLIC_KEY_PATH)) {
    pem = fs.readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8');
  } else {
    // Default certs directory in hotel-backend
    const defaultPath = path.resolve(process.cwd(), 'certs/jwt-public.pem');
    const moduleFallbackPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../certs/jwt-public.pem');
    if (fs.existsSync(defaultPath)) {
      pem = fs.readFileSync(defaultPath, 'utf8');
    } else if (fs.existsSync(moduleFallbackPath)) {
      pem = fs.readFileSync(moduleFallbackPath, 'utf8');
    }
  }

  if (pem) {
    try {
      cachedPublicKey = await jose.importSPKI(pem, 'RS256');
      return cachedPublicKey;
    } catch (e) {
      console.warn('Failed to import RS256 public key:', e);
    }
  }
  return null;
}

export async function verifyUnifiedToken(token: string): Promise<VerifiedUserIdentity> {
  if (!token || typeof token !== 'string') {
    throw new UnauthenticatedError('Missing token');
  }

  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    throw new UnauthenticatedError('Malformed token');
  }

  const alg = header.alg;
  if (alg !== 'RS256' && alg !== 'HS256') {
    throw new UnauthenticatedError(`Unexpected token algorithm: ${alg}`);
  }

  let verifyKey: KeyInput | null = null;
  if (alg === 'RS256') {
    verifyKey = await getPublicKey();
    if (!verifyKey) {
      throw new UnauthenticatedError('Public key not configured for RS256 token verification');
    }
  } else {
    verifyKey = new TextEncoder().encode(env.JWT_SECRET);
  }

  const validIssuers = new Set(
    [env.JWT_ISSUER, 'vuelitos-auth', 'vuelitos-flight-auth'].filter(Boolean)
  );
  const validAudiences = new Set(
    [env.JWT_AUDIENCE, 'vuelitos-platform', 'vuelitos-api'].filter(Boolean)
  );

  let payload: jose.JWTPayload;
  try {
    // Legacy Flight Backend HS256 tokens omit iss/aud; validate those only when present.
    const result = await jose.jwtVerify(token, verifyKey, { algorithms: [alg] });
    payload = result.payload;

    if (payload.iss != null && !validIssuers.has(String(payload.iss))) {
      throw new jose.errors.JWTClaimValidationFailed(
        'unexpected "iss" claim value',
        payload,
        'iss',
        'check'
      );
    }

    if (payload.aud != null) {
      const audValues = Array.isArray(payload.aud)
        ? payload.aud.map(String)
        : [String(payload.aud)];
      const audienceOk = audValues.some((aud) => validAudiences.has(aud));
      if (!audienceOk) {
        throw new jose.errors.JWTClaimValidationFailed(
          'unexpected "aud" claim value',
          payload,
          'aud',
          'check'
        );
      }
    }
  } catch (err: any) {
    if (err.code === 'ERR_JWT_EXPIRED') {
      throw new UnauthenticatedError('Token expired');
    }
    if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      throw new UnauthenticatedError('Token claim validation failed');
    }
    throw new UnauthenticatedError('Invalid token signature or payload');
  }

  // Security check: Refresh tokens MUST NEVER be used as access tokens
  if (payload.token_type === 'refresh') {
    throw new UnauthenticatedError('Refresh tokens cannot be used as access tokens');
  }

  const userId = String(payload.userId ?? payload.sub ?? '');
  if (!userId) {
    throw new UnauthenticatedError('Token missing subject/userId claim');
  }

  return {
    id: userId,
    sub: String(payload.sub ?? userId),
    email: payload.email ? String(payload.email) : undefined,
    role: String(payload.role ?? 'USER'),
    roleId: payload.roleId != null ? String(payload.roleId) : undefined,
    userType: payload.userType != null ? String(payload.userType) : undefined,
    tokenType: String(payload.token_type ?? 'access'),
    rawPayload: payload as Record<string, any>,
  };
}
