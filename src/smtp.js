import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import tls from 'node:tls';
import { SMTPServer } from 'smtp-server';
import { MAX_CREDENTIAL_LENGTH } from './config.js';

// Let's Encrypt renews certificates ~30 days before they expire: re-reading them a few times
// a day means the running server never serves an expired certificate (no restart needed)
const TLS_RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
const QUOTA_WARNING_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SUBJECT_LENGTH = 998;

/**
 * Starts the mock SMTP server: every authenticated message is stored in the inbox identified
 * by the SMTP username + password (any credentials are accepted, they just pick the inbox).
 */
export async function startSmtpServer({ db, config, log }) {
    let tlsFiles = config.secure ? readTlsFiles(config) : null;
    if (tlsFiles) checkCertificateExpiry(tlsFiles.cert, log, { verbose: true });
    const allowMessageFrom = createRateLimiter(config.rateLimitPerMinute, 60_000);
    let lastQuotaWarning = 0;

    const server = new SMTPServer({
        secure: config.secure,
        ...tlsFiles,
        // Credentials are mandatory: they identify the inbox the message belongs to
        authOptional: false,
        // Plain-text AUTH is only possible in local development (SMTP_SECURE=false)
        allowInsecureAuth: !config.secure,
        // In development never offer STARTTLS with smtp-server's built-in, publicly known test key
        disabledCommands: config.secure ? [] : ['STARTTLS'],
        size: config.maxMessageBytes,
        maxClients: config.maxClients,
        maxRecipients: config.maxRecipients,
        closeTimeout: 8_000,
        disableReverseLookup: true,
        logger: false,

        onAuth(auth, session, callback) {
            if (!isValidCredential(auth.username) || !isValidCredential(auth.password)) {
                return callback(
                    smtpError(535, `Authentication failed: username and password must be 1-${MAX_CREDENTIAL_LENGTH} characters`),
                );
            }
            callback(null, { user: { username: auth.username, password: auth.password } });
        },

        onMailFrom(address, session, callback) {
            if (!allowMessageFrom(session.remoteAddress)) {
                return callback(smtpError(451, 'Too many messages, please try again later'));
            }
            if (config.maxStorageBytes > 0) {
                let used;
                try {
                    used = db.usedBytes();
                } catch (err) {
                    log.error('Could not read the database size', err);
                    return callback(smtpError(451, 'Local error, please try again later'));
                }
                if (used >= config.maxStorageBytes) {
                    if (Date.now() - lastQuotaWarning > QUOTA_WARNING_INTERVAL_MS) {
                        lastQuotaWarning = Date.now();
                        log.warn(`Storage quota reached (${toMiB(used)} of ${toMiB(config.maxStorageBytes)}): rejecting new messages`);
                    }
                    return callback(smtpError(452, 'Insufficient storage, please try again later'));
                }
            }
            callback();
        },

        onData(stream, session, callback) {
            const chunks = [];
            let finished = false;
            const finish = (err) => {
                if (finished) return;
                finished = true;
                callback(err);
            };

            // Stop buffering past the size limit, but keep draining the stream until the end
            stream.on('data', (chunk) => {
                if (!stream.sizeExceeded) chunks.push(chunk);
            });

            stream.once('error', (err) => {
                log.warn('Error while receiving a message', err);
                finish(smtpError(451, 'Local error, please try again later'));
            });

            stream.once('end', () => {
                if (stream.sizeExceeded) {
                    return finish(smtpError(552, `Message exceeds the maximum size of ${config.maxMessageBytes} bytes`));
                }
                if (!session.user) {
                    return finish(smtpError(530, 'Authentication required'));
                }
                try {
                    const raw = Buffer.concat(chunks);
                    const content = raw.toString('utf8');
                    const id = db.insertEmail({
                        username: session.user.username,
                        password: session.user.password,
                        sender: session.envelope.mailFrom?.address ?? '',
                        recipients: session.envelope.rcptTo.map((rcpt) => rcpt.address).join(', '),
                        subject: extractSubject(content),
                        content,
                    });
                    log.info(`Stored message #${id}`, {
                        bytes: raw.length,
                        recipients: session.envelope.rcptTo.length,
                        client: session.remoteAddress,
                    });
                    finish();
                } catch (err) {
                    log.error('Could not store a message', err);
                    finish(smtpError(451, 'Local error, please try again later'));
                }
            });
        },
    });

    // Client-side problems (resets, failed TLS handshakes from scanners, timeouts...): not actionable
    server.on('error', (err) => {
        log.debug('SMTP connection error', { code: err.code, message: err.message, client: err.remote });
    });

    await listen(server, config);

    /** Re-reads the TLS key/certificate and applies them to new connections if they changed. */
    const reloadCertificates = () => {
        if (!config.secure) return false;
        let files;
        try {
            files = readTlsFiles(config);
        } catch (err) {
            log.error('Could not reload the TLS certificate, keeping the current one', err);
            return false;
        }
        if (files.key.equals(tlsFiles.key) && files.cert.equals(tlsFiles.cert)) {
            checkCertificateExpiry(tlsFiles.cert, log, { verbose: false });
            return false;
        }
        server.updateSecureContext(files);
        tlsFiles = files;
        log.info('TLS certificate reloaded');
        checkCertificateExpiry(tlsFiles.cert, log, { verbose: true });
        return true;
    };
    const reloadTimer = config.secure ? setInterval(reloadCertificates, TLS_RELOAD_INTERVAL_MS).unref() : null;

    return {
        address: server.server.address(),
        reloadCertificates,
        close: () =>
            new Promise((resolve) => {
                clearInterval(reloadTimer);
                server.close(resolve);
            }),
    };
}

/** Extracts the (unfolded) Subject header from a raw message, looking at the header block only. */
export function extractSubject(raw) {
    const headerEnd = raw.search(/\r?\n\r?\n/);
    const headers = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
    const match = /^subject:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im.exec(headers);
    const subject = match?.[1].replace(/\r?\n[ \t]+/g, ' ').trim();
    return subject ? subject.slice(0, MAX_SUBJECT_LENGTH) : 'No subject';
}

function readTlsFiles({ tlsKeyPath, tlsCertPath }) {
    let files;
    try {
        files = { key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) };
    } catch (err) {
        throw new Error(
            `Cannot read the TLS key/certificate (SMTP_TLS_KEY=${tlsKeyPath}, SMTP_TLS_CERT=${tlsCertPath}): ${err.message}. ` +
                'See "TLS certificates" in the README.',
            { cause: err },
        );
    }
    tls.createSecureContext(files); // throws if the key and certificate are invalid or don't match
    return files;
}

function checkCertificateExpiry(cert, log, { verbose }) {
    const { validTo } = new X509Certificate(cert);
    const daysLeft = Math.floor((Date.parse(validTo) - Date.now()) / 86_400_000);
    if (daysLeft < 7) log.warn(`TLS certificate expires on ${validTo} (${daysLeft} days left): check the renewal`);
    else if (verbose) log.info(`TLS certificate valid until ${validTo}`);
}

function listen(server, { port, host }) {
    return new Promise((resolve, reject) => {
        // Errors while binding (EADDRINUSE, EACCES...) must stop the process, so pm2 reports them
        const onError = (err) => reject(err);
        server.server.once('error', onError);
        server.listen({ port, host }, () => {
            server.server.off('error', onError);
            resolve();
        });
    });
}

/** Fixed window counter per key; returns false once `limit` is exceeded in the current window. */
function createRateLimiter(limit, windowMs) {
    if (limit <= 0) return () => true;
    const hits = new Map();
    let windowStart = Date.now();
    return (key) => {
        const now = Date.now();
        if (now - windowStart >= windowMs) {
            hits.clear();
            windowStart = now;
        }
        const count = (hits.get(key) ?? 0) + 1;
        hits.set(key, count);
        return count <= limit;
    };
}

function isValidCredential(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_CREDENTIAL_LENGTH;
}

function smtpError(responseCode, message) {
    return Object.assign(new Error(message), { responseCode });
}

function toMiB(bytes) {
    return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
