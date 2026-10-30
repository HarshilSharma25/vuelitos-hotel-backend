import { Worker } from 'bullmq';
import { env } from './config/env.js';
import {
  processExpiryJob,
  processSlaWatchJob,
  processRatesBcvJob,
  processRatesUsdtJob,
  setupRepeatableJobs,
} from './jobs/scheduler.js';
import { tarifarioService } from './modules/tarifario/service.js';

console.log('Starting background worker...');

// Register scheduled repeatable jobs
setupRepeatableJobs().catch((err) => {
  console.warn('Initial scheduler setup warning:', err.message);
});

const worker = new Worker(
  'hotel-scheduler',
  async (job) => {
    console.log(`Processing job ${job.name} (id: ${job.id})`);
    switch (job.name) {
      case 'bookings.expire-payment-window':
        await processExpiryJob();
        break;
      case 'bookings.sla-watch':
        await processSlaWatchJob();
        break;
      case 'rates.usdt':
        await processRatesUsdtJob();
        break;
      case 'rates.bcv':
        await processRatesBcvJob();
        break;
      case 'tarifario.import':
        if (job.data?.isCommit) {
          await tarifarioService.commit(job.data.planId, job.data.expectedHash);
        } else {
          await tarifarioService.dryRun(job.data.doc);
        }
        break;
      default:
        console.warn(`Unknown job name: ${job.name}`);
    }
  },
  { connection: { url: env.REDIS_URL } }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.name} completed successfully.`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.name} failed:`, err);
});

const gracefulShutdown = async () => {
  console.log('Closing background worker...');
  await worker.close();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
