import { env } from '../../config/env.js';

function normalizeBucket(bucket: string): string {
  const noTrail = bucket.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(noTrail)) return noTrail;
  return `https://${noTrail}`;
}

/** Join a bucket host with a storage key. Absolute inputs are returned unchanged. */
export function joinBucketUrl(bucket: string, key: string): string {
  const trimmed = key.trim();
  if (/^(https?:|blob:|data:)/i.test(trimmed)) return trimmed;
  return `${normalizeBucket(bucket)}/${trimmed.replace(/^\/+/, '')}`;
}

export function publicFileUrl(key: string): string {
  return joinBucketUrl(env.FILES_BUCKET_URL || env.FILES_PUBLIC_BASE_URL, key);
}

function pointsAtOwnHost(url: string): boolean {
  const bases = [env.FILES_BUCKET_URL, env.FILES_PUBLIC_BASE_URL, env.PUBLIC_API_ORIGIN]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeBucket(value));
  return bases.some((base) => url.startsWith(`${base}/`) || url === base);
}

/**
 * Prefer an externally stored cover URL (Unsplash, CDN).
 * Storage keys and URLs we previously built on the API host are rewritten onto the bucket.
 */
export function resolveCoverImageUrl(key?: string | null, stored?: string | null): string | null {
  if (stored && /^https?:\/\//i.test(stored) && !pointsAtOwnHost(stored)) {
    return stored;
  }
  if (key) return publicFileUrl(key);
  return stored ?? null;
}
