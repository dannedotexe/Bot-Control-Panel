// pm2-Definition NUR für das Panel selbst. Bestehende Bots werden nicht angefasst.
module.exports = {
  apps: [
    {
      name: 'bot-control-panel',
      script: 'server/index.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      node_args: '--max-old-space-size=48',
      max_memory_restart: '120M',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 3000,
      time: true,
      pmx: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
