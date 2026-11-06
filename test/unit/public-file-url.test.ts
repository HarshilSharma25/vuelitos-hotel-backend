import { describe, expect, it } from 'vitest';
import { joinBucketUrl } from '../../src/modules/files/public-url.js';

describe('joinBucketUrl', () => {
  it('joins a host with the storage key', () => {
    expect(
      joinBucketUrl(
        'dev-bucket.softnear.xyz',
        'public/hotels/010f61e7-4dc7-4d88-810b-85e7f760d882/34ea4f5b-00d8-4335-9405-508bcd0dde9d.webp'
      )
    ).toBe(
      'https://dev-bucket.softnear.xyz/public/hotels/010f61e7-4dc7-4d88-810b-85e7f760d882/34ea4f5b-00d8-4335-9405-508bcd0dde9d.webp'
    );
  });

  it('accepts a bucket value that already includes https', () => {
    expect(joinBucketUrl('https://dev-bucket.softnear.xyz/', 'public/hotels/a.webp')).toBe(
      'https://dev-bucket.softnear.xyz/public/hotels/a.webp'
    );
  });

  it('leaves an absolute url unchanged', () => {
    expect(joinBucketUrl('https://dev-bucket.softnear.xyz', 'https://images.example.com/cover.webp')).toBe(
      'https://images.example.com/cover.webp'
    );
  });
});
