'use strict';

/**
 * PM2 Ecosystem Config
 * Start in production: pm2 start ecosystem.config.js
 * Monitor:            pm2 monit
 * Logs:               pm2 logs birthday-bot
 * Auto-restart on boot: pm2 startup && pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'birthday-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,  // wait 5s before restarting on crash
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
};
