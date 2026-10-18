const HOUR = 60 * 60 * 1000;

/** Deletes emails older than `retentionDays`, at startup and then every hour. */
export function startRetentionJob({ db, retentionDays, log, intervalMs = HOUR }) {
    if (retentionDays <= 0) {
        log.warn('RETENTION_DAYS=0: old emails are never deleted');
        return { run: async () => 0, stop: () => {} };
    }

    let running = false;
    const run = async () => {
        if (running) return 0;
        running = true;
        try {
            const deleted = await db.purgeOlderThan(retentionDays);
            if (deleted > 0) log.info(`Deleted ${deleted} email(s) older than ${retentionDays} days`);
            return deleted;
        } catch (err) {
            log.error('Could not delete old emails', err);
            return 0;
        } finally {
            running = false;
        }
    };

    const timer = setInterval(run, intervalMs).unref();
    run();
    return { run, stop: () => clearInterval(timer) };
}
