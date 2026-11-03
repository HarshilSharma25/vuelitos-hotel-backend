import { describe, expect, it } from 'vitest';
import { decodePdfBase64Field } from '../../src/lib/pdf-payload-decode.js';

describe('decodePdfBase64Field', () => {
  it('decodes standard base64 PDF header', () => {
    const b64 = Buffer.from('%PDF-1.4\n', 'utf8').toString('base64');
    const buf = decodePdfBase64Field(b64);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('decodes legacy comma-separated byte strings', () => {
    const legacy = [0x25, 0x50, 0x44, 0x46, 0x2d].join(',');
    const buf = decodePdfBase64Field(legacy);
    expect(buf.toString('ascii')).toBe('%PDF-');
  });
});
