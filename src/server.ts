import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      { port: env.PORT, err: err.message },
      `Port ${env.PORT} is already in use. Set PORT in .env.local (e.g. 3002) and point VITE_HOTEL_BACKEND_URL at the same URL.`
    );
  } else {
    logger.error({ err }, 'Server failed to start');
  }
  process.exit(1);
});

const gracefulShutdown = () => {
  logger.info('Received shutdown signal, closing server gracefully...');
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
