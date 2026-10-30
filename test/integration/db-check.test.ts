import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';

describe('Database Connectivity Smoke Test', () => {
  it('connects to PostgreSQL database', async () => {
    const result = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`;
    expect(result[0]?.ok).toBe(1);
  });
});
