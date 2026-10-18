import path from 'node:path';

/** Project root: relative paths must not depend on the directory pm2 was started from. */
export const PROJECT_DIR = path.resolve(import.meta.dirname, '..');

/** Max length of an inbox username/password. SMTP AUTH and the API share this limit. */
export const MAX_CREDENTIAL_LENGTH = 256;

const MiB = 1024 * 1024;

/**
 * Loads <project>/.env if present. Variables already set (by pm2, the shell...) take precedence.
 * Call it first: the logger reads LOG_LEVEL.
 */
export function loadEnvFile() {
    try {
        process.loadEnvFile(path.join(PROJECT_DIR, '.env'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

/**
 * Reads the configuration from environment variables (see .env.example).
 * Defaults match the original deployment, so an existing setup keeps working unchanged.
 */
export function loadConfig(env = process.env) {
    const read = (name) => {
        const value = env[name]?.trim();
        return value ? value : undefined;
    };

    const string = (name, fallback) => read(name) ?? fallback;

    const integer = (name, fallback, min, max) => {
        const raw = read(name);
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`Invalid ${name}="${raw}": expected an integer between ${min} and ${max}`);
        }
        return value;
    };

    const boolean = (name, fallback) => {
        const raw = read(name)?.toLowerCase();
        if (raw === undefined) return fallback;
        if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
        if (['0', 'false', 'no', 'off'].includes(raw)) return false;
        throw new Error(`Invalid ${name}="${raw}": expected true or false`);
    };

    return {
        dbPath: path.resolve(PROJECT_DIR, string('DB_PATH', 'emails.sql')),
        // Emails older than this are deleted (0 disables the cleanup)
        retentionDays: integer('RETENTION_DAYS', 30, 0, 3650),

        smtp: {
            // undefined = all interfaces (the SMTP server must be reachable from the internet)
            host: string('SMTP_HOST', undefined),
            port: integer('SMTP_PORT', 2525, 0, 65535),
            // Implicit TLS (like port 465). Set to false only for local development.
            secure: boolean('SMTP_SECURE', true),
            tlsKeyPath: string('SMTP_TLS_KEY', '/etc/letsencrypt/live/test.opentrust.it/privkey.pem'),
            tlsCertPath: string('SMTP_TLS_CERT', '/etc/letsencrypt/live/test.opentrust.it/fullchain.pem'),
            maxMessageBytes: integer('SMTP_MAX_MESSAGE_MB', 10, 1, 100) * MiB,
            maxClients: integer('SMTP_MAX_CLIENTS', 20, 1, 10_000),
            maxRecipients: integer('SMTP_MAX_RECIPIENTS', 50, 1, 10_000),
            // Messages per minute per client IP (0 disables the limit)
            rateLimitPerMinute: integer('SMTP_RATE_LIMIT', 120, 0, 1_000_000),
            // New messages are refused (452, retry later) once the database holds this much data (0 = unlimited)
            maxStorageBytes: integer('MAX_STORAGE_MB', 2048, 0, 10_000_000) * MiB,
        },

        api: {
            // Only reachable through the reverse proxy (nginx) by default
            host: string('API_HOST', 'localhost'),
            port: integer('API_PORT', 3628, 0, 65535),
            corsOrigin: parseCorsOrigin(string('CORS_ORIGIN', '*')),
            trustProxy: parseTrustProxy(string('TRUST_PROXY', 'loopback')),
            // Requests per minute per client IP (0 disables the limit)
            rateLimitPerMinute: integer('API_RATE_LIMIT', 300, 0, 1_000_000),
        },
    };
}

function parseCorsOrigin(value) {
    if (value === '*') return '*';
    return value.split(',').map((entry) => {
        const origin = entry.trim();
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error(`Invalid CORS_ORIGIN entry "${origin}": expected e.g. https://example.com`);
        }
        if (parsed.origin !== origin) {
            throw new Error(`Invalid CORS_ORIGIN entry "${origin}": use the bare origin "${parsed.origin}"`);
        }
        return origin;
    });
}

function parseTrustProxy(value) {
    const lower = value.toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    // Comma separated IPs/CIDRs or the "loopback", "linklocal", "uniquelocal" presets
    return value;
}
