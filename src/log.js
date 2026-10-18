const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimal timestamped logger (stdout/stderr end up in the pm2 logs).
 * Never pass credentials or email contents to it.
 */
export function createLogger(scope, level = process.env.LOG_LEVEL ?? 'info') {
    const threshold = LEVELS[level] ?? LEVELS.info;

    const write = (lvl, message, detail) => {
        if (LEVELS[lvl] < threshold) return;
        let line = `${new Date().toISOString()} ${lvl.toUpperCase()} [${scope}] ${message}`;
        if (detail instanceof Error) line += `: ${detail.stack ?? detail.message}`;
        else if (detail !== undefined) line += ` ${JSON.stringify(detail)}`;
        if (LEVELS[lvl] >= LEVELS.warn) console.error(line);
        else console.log(line);
    };

    return {
        debug: (message, detail) => write('debug', message, detail),
        info: (message, detail) => write('info', message, detail),
        warn: (message, detail) => write('warn', message, detail),
        error: (message, detail) => write('error', message, detail),
    };
}
