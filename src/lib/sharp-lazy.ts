import type sharp from 'sharp';

type SharpFn = typeof sharp;

let cached: SharpFn | null | undefined;

export async function getSharp(): Promise<SharpFn | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = await import('sharp');
    cached = mod.default;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}
