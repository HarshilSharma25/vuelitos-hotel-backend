export function calculateIqrMedian(prices: number[]): number {
  if (prices.length === 0) {
    throw new Error('Cannot calculate IQR median of an empty array');
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 1) return Number(sorted[0].toFixed(4));

  // Compute quartiles
  const getPercentile = (p: number): number => {
    const idx = (n - 1) * p;
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  const q1 = getPercentile(0.25);
  const q3 = getPercentile(0.75);
  const iqr = q3 - q1;

  const minBound = q1 - 1.5 * iqr;
  const maxBound = q3 + 1.5 * iqr;

  const filtered = sorted.filter((p) => p >= minBound && p <= maxBound);
  const m = filtered.length;

  if (m === 0) {
    // Fallback if all were somehow filtered out
    return Number(sorted[Math.floor(n / 2)].toFixed(4));
  }

  let median: number;
  if (m % 2 === 1) {
    median = filtered[Math.floor(m / 2)];
  } else {
    median = (filtered[m / 2 - 1] + filtered[m / 2]) / 2;
  }

  return Number(median.toFixed(4));
}

export async function fetchBinanceUsdtRate(): Promise<number> {
  const url = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
  const prices: number[] = [];

  for (let page = 1; page <= 2; page++) {
    const payload = {
      page,
      rows: 20,
      payTypes: [],
      asset: 'USDT',
      tradeType: 'BUY',
      fiat: 'VES',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (VuelitosBackend/1.0)',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Binance P2P HTTP request failed: ${res.status} ${res.statusText}`);
    }

    const data: any = await res.json();
    if (!data.data || !Array.isArray(data.data)) {
      break;
    }

    for (const item of data.data) {
      const priceStr = item.adv?.price;
      if (priceStr) {
        const p = parseFloat(priceStr);
        if (Number.isFinite(p) && p > 0) {
          prices.push(p);
        }
      }
    }
  }

  if (prices.length === 0) {
    throw new Error('No prices retrieved from Binance P2P ads');
  }

  return calculateIqrMedian(prices);
}
