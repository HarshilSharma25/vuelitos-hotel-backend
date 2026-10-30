import fs from 'node:fs';
import path from 'node:path';
import { tarifarioService } from '../modules/tarifario/service.js';
import { prisma } from '../lib/prisma.js';

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith('--'));
  const isCommit = args.includes('--commit');

  if (!filePath) {
    console.error('Usage: tsx src/cli/tarifario-import.ts <path-to-json> [--commit]');
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const data = JSON.parse(raw);

  console.log(`[Tarifario CLI] Running dry-run for ${filePath}...`);
  const plan = await tarifarioService.dryRun(data);

  console.log(plan.diffMarkdown);
  console.log('\nSummary:', plan.summary);

  if (isCommit) {
    console.log(`\n[Tarifario CLI] Applying commit for plan ${plan.planId}...`);
    const res = await tarifarioService.commit(plan.planId, plan.snapshotHash);
    console.log('[Tarifario CLI] Successfully committed!', res.summary);
  } else {
    console.log('\n[Tarifario CLI] Dry run finished. Run with --commit to apply changes.');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[Tarifario CLI] Error:', err);
  process.exit(1);
});
