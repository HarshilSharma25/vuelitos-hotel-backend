import { describe, it, expect } from 'vitest';
import { calculateIqrMedian } from '../../src/modules/rates/sources/binance.js';
import { parseBcvHtml } from '../../src/modules/rates/sources/bcv.js';

describe('Exchange Rates Sources & IQR Filtering', () => {
  it('calculates IQR median correctly and discards extreme outliers', () => {
    // 20 realistic prices around 46.5 with 2 extreme outliers (10.0 and 150.0)
    const prices = [
      46.2, 46.3, 46.4, 46.5, 46.5,
      46.6, 46.6, 46.7, 46.7, 46.8,
      46.8, 46.9, 46.9, 47.0, 47.1,
      46.4, 46.5, 46.6, 10.0, 150.0,
    ];

    const median = calculateIqrMedian(prices);
    // Outliers 10.0 and 150.0 must be dropped by IQR filter
    expect(median).toBeGreaterThanOrEqual(46.5);
    expect(median).toBeLessThanOrEqual(46.8);
  });

  it('calculates median for single item and uniform arrays', () => {
    expect(calculateIqrMedian([45.5])).toBe(45.5);
    expect(calculateIqrMedian([40, 40, 40])).toBe(40);
  });

  it('parses BCV HTML and extracts USD, EUR, and Fecha Valor', () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="view-tipo-de-cambio-oficial-del-bcv">
            <div id="dolar">
              <span>USD</span>
              <strong> 45,23450000 </strong>
            </div>
            <div id="euro">
              <span>EUR</span>
              <strong> 49,87650000 </strong>
            </div>
            <div class="pull-right dinpro">
              <span class="date-display-single" content="2026-10-29T00:00:00-04:00">Jueves, 29 Octubre 2026</span>
            </div>
          </div>
        </body>
      </html>
    `;

    const res = parseBcvHtml(mockHtml);
    expect(res.usd).toBe(45.2345);
    expect(res.eur).toBe(49.8765);
    expect(res.valueDate).toBe('2026-10-29');
  });

  it('throws when HTML does not contain required BCV rates', () => {
    const badHtml = '<html><body>Not a BCV page</body></html>';
    expect(() => parseBcvHtml(badHtml)).toThrow();
  });
});
