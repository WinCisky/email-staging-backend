// pm2 process file (CommonJS, because package.json has "type": "module"). See "Deploy with pm2" in the README.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// Settings go in .env (see .env.example), loaded by the apps at startup: `pm2 restart` to apply changes.
const shared = {
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
    // Rate limits and SMTP sessions live in memory: run exactly one process each, never cluster mode
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    exp_backoff_restart_delay: 1000, // don't hammer the machine if a process keeps crashing
    kill_timeout: 15_000, // let the graceful shutdown (max 10 s) finish; the pm2 default is 1.6 s
    max_memory_restart: '512M',
    watch: false,
};

module.exports = {
    apps: [
        { ...shared, name: 'email-staging-smtp', script: './smtp-mock-server.js' },
        { ...shared, name: 'email-staging-api', script: './api.js' },
    ],
};
