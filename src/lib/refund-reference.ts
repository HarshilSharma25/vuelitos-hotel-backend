import { prisma } from './prisma.js';

export async function allocateRefundPublicReference(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `RF-${year}-`;
  const latest = await prisma.refundRequest.findFirst({
    where: { publicReference: { startsWith: prefix } },
    orderBy: { publicReference: 'desc' },
    select: { publicReference: true },
  });
  let seq = 1;
  if (latest?.publicReference) {
    const tail = latest.publicReference.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(6, '0')}`;
}
