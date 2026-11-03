export function decodePdfBase64Field(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) return Buffer.alloc(0);

  const head = trimmed.slice(0, 64);
  if (/^\d+(,\d+)*/.test(head)) {
    const bytes = trimmed
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
    return Buffer.from(bytes);
  }

  return Buffer.from(trimmed, 'base64');
}
