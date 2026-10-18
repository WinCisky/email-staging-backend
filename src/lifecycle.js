/**
 * Graceful shutdown on SIGINT (sent by `pm2 stop/restart/reload`) and SIGTERM.
 * Keep `timeoutMs` below pm2's kill_timeout (see ecosystem.config.cjs).
 */
export function handleShutdown(log, cleanup, { timeoutMs = 10_000 } = {}) {
    let shuttingDown = false;

    const onSignal = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`${signal} received, shutting down`);

        setTimeout(() => {
            log.error(`Graceful shutdown took more than ${timeoutMs} ms, exiting`);
            process.exit(1);
        }, timeoutMs).unref();

        try {
            await cleanup();
            log.info('Shutdown complete');
            process.exit(0);
        } catch (err) {
            log.error('Error during shutdown', err);
            process.exit(1);
        }
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
}

/** Startup errors (invalid config, port in use, unreadable certificate...) must stop the process. */
export function exitOnStartupError(log) {
    return (err) => {
        log.error('Startup failed', err);
        process.exit(1);
    };
}

export function warnIfRoot(log) {
    if (process.getuid?.() === 0) {
        log.warn('Running as root is not needed and not recommended: run pm2 as an unprivileged user (see README)');
    }
}
