import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';

describe('Database Connectivity Smoke Test', () => {
  it('connects to the MySQL database', async () => {
    const result = await prisma.$queryRaw<Array<{ ok: number | bigint }>>`SELECT 1 as ok`;
    expect(Number(result[0]?.ok)).toBe(1);
  });
});
