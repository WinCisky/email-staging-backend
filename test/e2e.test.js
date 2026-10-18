import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_DIR } from '../src/config.js';
import { AUTH, sendMail, smtpConversation, tempDir } from './helpers.js';

/** Runs an entrypoint the way pm2 does: a separate node process, stopped with SIGINT. */
function run(t, script, env) {
    const child = spawn(process.execPath, [script], {
        cwd: PROJECT_DIR,
        env: { ...process.env, LOG_LEVEL: 'info', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = once(child, 'exit').then(([code]) => code); // subscribed right away: never misses the event
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    t.after(() => child.exitCode === null && child.kill('SIGKILL'));

    const waitFor = async (pattern, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const match = output.match(pattern);
            if (match) return match;
            if (child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`${script}: "${pattern}" not found in output:\n${output}`);
    };
    const stop = (signal = 'SIGINT') => {
        child.kill(signal);
        return exit;
    };
    return { child, exit, waitFor, stop, output: () => output };
}

test('SMTP + API processes: receive, read, survive bad clients, shut down gracefully', async (t) => {
    const dbPath = path.join(tempDir(t), 'emails.sql');
    const smtp = run(t, 'smtp-mock-server.js', { DB_PATH: dbPath, SMTP_SECURE: 'false', SMTP_HOST: '127.0.0.1', SMTP_PORT: '0' });
    const api = run(t, 'api.js', { DB_PATH: dbPath, API_HOST: '127.0.0.1', API_PORT: '0' });
    const smtpPort = Number((await smtp.waitFor(/SMTP server listening on 127\.0\.0\.1:(\d+)/))[1]);
    const apiPort = Number((await api.waitFor(/HTTP API listening on 127\.0\.0\.1:(\d+)/))[1]);

    // Unauthenticated client: rejected, process keeps running
    const replies = await smtpConversation(smtpPort, ['EHLO test', 'MAIL FROM:<a@example.com>', 'RCPT TO:<b@example.com>', 'QUIT']);
    assert.match(replies[2], /^530 /);
    assert.equal(smtp.child.exitCode, null);

    await sendMail({ port: smtpPort }, AUTH, { subject: 'End to end' });

    const response = await fetch(`http://127.0.0.1:${apiPort}/emails?username=${AUTH.user}&password=${AUTH.pass}`);
    assert.equal(response.status, 200);
    const [email] = await response.json();
    assert.equal(email.subject, 'End to end');
    assert.equal(email.password, undefined);

    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);

    assert.equal(await smtp.stop('SIGINT'), 0);
    assert.equal(await api.stop('SIGTERM'), 0);
    assert.match(smtp.output(), /Shutdown complete/);
    assert.match(api.output(), /Shutdown complete/);
});

test('startup errors stop the process with a clear message (pm2 shows it as errored)', async (t) => {
    const dir = tempDir(t);
    const missingCert = run(t, 'smtp-mock-server.js', {
        DB_PATH: path.join(dir, 'a.sql'),
        SMTP_PORT: '0',
        SMTP_TLS_KEY: path.join(dir, 'missing-key.pem'),
        SMTP_TLS_CERT: path.join(dir, 'missing-cert.pem'),
    });
    await missingCert.waitFor(/Cannot read the TLS key\/certificate/);
    assert.equal(await missingCert.exit, 1);

    const blocker = net.createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    t.after(() => blocker.close());
    const portInUse = run(t, 'smtp-mock-server.js', {
        DB_PATH: path.join(dir, 'b.sql'),
        SMTP_SECURE: 'false',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(blocker.address().port),
    });
    await portInUse.waitFor(/EADDRINUSE/);
    assert.equal(await portInUse.exit, 1);

    const badConfig = run(t, 'api.js', { DB_PATH: path.join(dir, 'c.sql'), API_PORT: 'eighty' });
    await badConfig.waitFor(/Invalid API_PORT="eighty"/);
    assert.equal(await badConfig.exit, 1);
});
