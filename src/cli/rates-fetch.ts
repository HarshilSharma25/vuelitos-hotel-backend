import { fetchBcvRates } from '../modules/rates/sources/bcv.js';
import { fetchBinanceUsdtRate } from '../modules/rates/sources/binance.js';
import { composeAndPersistRates } from '../modules/rates/compose.js';
import { prisma } from '../lib/prisma.js';

async function run() {
  console.log('[CLI] Fetching exchange rates from sources...');

  let freshBcv = null;
  try {
    freshBcv = await fetchBcvRates();
    console.log(`[CLI] BCV fetched successfully: USD=${freshBcv.usd}, EUR=${freshBcv.eur}, FechaValor=${freshBcv.valueDate}`);
  } catch (err: any) {
    console.warn(`[CLI] BCV fetch failed: ${err.message}`);
  }

  let freshUsdt = null;
  try {
    freshUsdt = await fetchBinanceUsdtRate();
    console.log(`[CLI] Binance USDT fetched successfully: ${freshUsdt}`);
  } catch (err: any) {
    console.warn(`[CLI] Binance USDT fetch failed: ${err.message}`);
  }

  if (!freshBcv && freshUsdt === null) {
    console.error('[CLI] ERROR: Both exchange rate sources failed.');
    process.exit(1);
  }

  const result = await composeAndPersistRates({ freshBcv, freshUsdt });
  console.log('[CLI] Composition complete:', result);
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('[CLI] Fatal error:', err);
  process.exit(1);
});
