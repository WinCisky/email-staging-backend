import { buildApi } from './src/api.js';
import { loadConfig, loadEnvFile } from './src/config.js';
import { openDatabase } from './src/db.js';
import { exitOnStartupError, handleShutdown, warnIfRoot } from './src/lifecycle.js';
import { createLogger } from './src/log.js';
import { startRetentionJob } from './src/retention.js';

loadEnvFile();
// Files created by this process (the database) are only accessible by its user
process.umask(0o077);

const log = createLogger('api');

async function main() {
    const config = loadConfig();
    warnIfRoot(log);

    const db = openDatabase(config.dbPath, { log });
    const app = await buildApi({ db, config: config.api, log });
    await app.listen({ host: config.api.host, port: config.api.port });

    const addresses = app.addresses().map(({ address, port }) => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`));
    log.info(`HTTP API listening on ${addresses.join(', ')}`);

    const retention = startRetentionJob({ db, retentionDays: config.retentionDays, log });

    handleShutdown(log, async () => {
        retention.stop();
        await app.close();
        db.close();
    });
}

main().catch(exitOnStartupError(log));
