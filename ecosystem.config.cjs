const shared = {
  interpreter: 'node',
  node_args: '--import tsx',
  instances: 1,
  exec_mode: 'fork',
  cwd: __dirname,
  time: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  merge_logs: true,
  ignore_watch: ['node_modules', 'logs', '.git', 'dist', 'uploads', 'private-uploads'],
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'HotelBackend-Prod',
      script: 'src/server.ts',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_local: {
        NODE_ENV: 'local',
        PORT: 3001,
      },
      error_file: './logs/pm2-hotel-api-error-prod.log',
      out_file: './logs/pm2-hotel-api-out-prod.log',
      log_file: './logs/pm2-hotel-api-combined-prod.log',
      max_memory_restart: '1G',
      watch: false,
    },
    {
      ...shared,
      name: 'HotelBackend-Worker-Prod',
      script: 'src/worker.ts',
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      env_local: {
        NODE_ENV: 'local',
      },
      error_file: './logs/pm2-hotel-worker-error-prod.log',
      out_file: './logs/pm2-hotel-worker-out-prod.log',
      log_file: './logs/pm2-hotel-worker-combined-prod.log',
      max_memory_restart: '1G',
      watch: false,
    },
    {
      ...shared,
      name: 'HotelBackend-Dev',
      script: 'src/server.ts',
      env_development: {
        NODE_ENV: 'development',
        PORT: 3003,
      },
      error_file: './logs/pm2-hotel-api-error-dev.log',
      out_file: './logs/pm2-hotel-api-out-dev.log',
      log_file: './logs/pm2-hotel-api-combined-dev.log',
      max_memory_restart: '512M',
      watch: true,
    },
    {
      ...shared,
      name: 'HotelBackend-Worker-Dev',
      script: 'src/worker.ts',
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './logs/pm2-hotel-worker-error-dev.log',
      out_file: './logs/pm2-hotel-worker-out-dev.log',
      log_file: './logs/pm2-hotel-worker-combined-dev.log',
      max_memory_restart: '512M',
      watch: true,
    },
    {
      ...shared,
      name: 'HotelBackend-UAT',
      script: 'src/server.ts',
      env: {
        NODE_ENV: 'uat',
        PORT: 3002,
      },
      env_uat: {
        NODE_ENV: 'uat',
        PORT: 3002,
      },
      error_file: './logs/pm2-hotel-api-error-uat.log',
      out_file: './logs/pm2-hotel-api-out-uat.log',
      log_file: './logs/pm2-hotel-api-combined-uat.log',
      max_memory_restart: '1G',
      watch: false,
    },
    {
      ...shared,
      name: 'HotelBackend-Worker-UAT',
      script: 'src/worker.ts',
      env: {
        NODE_ENV: 'uat',
      },
      env_uat: {
        NODE_ENV: 'uat',
      },
      error_file: './logs/pm2-hotel-worker-error-uat.log',
      out_file: './logs/pm2-hotel-worker-out-uat.log',
      log_file: './logs/pm2-hotel-worker-combined-uat.log',
      max_memory_restart: '1G',
      watch: false,
    },
  ],
};
