import { loadConfig, loadEnvFile } from './src/config.js';
import { openDatabase } from './src/db.js';
import { exitOnStartupError, handleShutdown, warnIfRoot } from './src/lifecycle.js';
import { createLogger } from './src/log.js';
import { startSmtpServer } from './src/smtp.js';

loadEnvFile();
// Files created by this process (the database) are only accessible by its user
process.umask(0o077);

const log = createLogger('smtp');

async function main() {
    const config = loadConfig();
    warnIfRoot(log);

    const db = openDatabase(config.dbPath, { log });
    const smtp = await startSmtpServer({ db, config: config.smtp, log });

    const { address, port } = smtp.address;
    const mode = config.smtp.secure ? 'implicit TLS' : 'PLAIN TEXT, development only';
    log.info(`SMTP server listening on ${address.includes(':') ? `[${address}]` : address}:${port} (${mode})`);

    // `pm2 sendSignal SIGHUP email-staging-smtp` reloads the TLS certificate right away
    process.on('SIGHUP', () => smtp.reloadCertificates());

    handleShutdown(log, async () => {
        await smtp.close();
        db.close();
    });
}

main().catch(exitOnStartupError(log));
