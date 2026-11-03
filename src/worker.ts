import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { captureException } from './lib/sentry.js';
import {
  processExpiryJob,
  processSlaWatchJob,
  processRatesBcvJob,
  processRatesUsdtJob,
  processStripeReconciliationJob,
  processPaymentRemindersJob,
  setupRepeatableJobs,
} from './jobs/scheduler.js';
import { tarifarioService } from './modules/tarifario/service.js';
import { processMailJob } from './modules/notifications/process-mail-job.js';

logger.info('Starting background worker...');

setupRepeatableJobs().catch((err) => {
  logger.warn({ err: err.message }, 'Initial scheduler setup warning');
});

const worker = new Worker(
  'hotel-scheduler',
  async (job) => {
    logger.info({ jobName: job.name, jobId: job.id }, `Processing job ${job.name}`);
    switch (job.name) {
      case 'bookings.expire-payment-window':
        await processExpiryJob();
        break;
      case 'bookings.payment-reminders':
        await processPaymentRemindersJob();
        break;
      case 'bookings.sla-watch':
        await processSlaWatchJob();
        break;
      case 'bookings.reconcile-stripe-payments':
        await processStripeReconciliationJob();
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
        logger.warn({ jobName: job.name }, `Unknown job name: ${job.name}`);
    }
  },
  { connection: { url: env.REDIS_URL } }
);

worker.on('completed', (job) => {
  logger.info({ jobName: job.name, jobId: job.id }, `Job ${job.name} completed successfully.`);
});

worker.on('failed', (job, err) => {
  logger.error({ jobName: job?.name, jobId: job?.id, err }, `Job ${job?.name} failed`);
  captureException(err, { jobName: job?.name, jobId: job?.id });
});

const gracefulShutdown = async () => {
  logger.info('Closing background worker...');
  await worker.close();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const mailWorker = new Worker(
  'hotel-notifications',
  async (job) => {
    await processMailJob(job);
  },
  { connection: { url: env.REDIS_URL } }
);

mailWorker.on('failed', (job, err) => {
  logger.error({ jobName: job?.name, jobId: job?.id, err }, 'Hotel notification job failed');
  captureException(err, { jobName: job?.name, jobId: job?.id, queue: 'hotel-notifications' });
});

const mailGraceful = async () => {
  await mailWorker.close();
};
process.on('SIGTERM', mailGraceful);
process.on('SIGINT', mailGraceful);
