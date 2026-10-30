import { runCatalogFixes } from '../modules/tarifario/catalog-fixes.js';
import { prisma } from '../lib/prisma.js';

async function main() {
  console.log('[Catalog Fixes] Running pending catalog fixes with price assertions...');
  const results = await runCatalogFixes([]);
  console.log(`[Catalog Fixes] Completed ${results.length} fixes.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[Catalog Fixes] Error:', err);
  process.exit(1);
});
