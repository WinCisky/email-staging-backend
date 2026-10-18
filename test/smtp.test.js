import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import tls from 'node:tls';
import { openDatabase } from '../src/db.js';
import { extractSubject, startSmtpServer } from '../src/smtp.js';
import {
    AUTH,
    generateCertificate,
    hasOpenssl,
    memoryLog,
    sendMail,
    smtpConversation,
    tempDir,
    testConfig,
} from './helpers.js';

async function startServer(t, overrides = {}) {
    const config = testConfig(tempDir(t));
    Object.assign(config.smtp, overrides);
    const db = openDatabase(config.dbPath);
    const log = memoryLog();
    const smtp = await startSmtpServer({ db, config: config.smtp, log });
    t.after(async () => {
        await smtp.close();
        db.close();
    });
    return { db, smtp, log, port: smtp.address.port };
}

const inbox = (db) => db.listEmails(AUTH.user, AUTH.pass, 100, 0);
const authPlain = (username, password) => `AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`).toString('base64')}`;

describe('SMTP server', () => {
    test('stores authenticated messages in the inbox named by the credentials', async (t) => {
        const { db, port } = await startServer(t);
        await sendMail({ port }, AUTH, { subject: 'Welcome aboard', to: ['a@example.com', 'b@example.com'] });

        const [email] = inbox(db);
        assert.equal(email.subject, 'Welcome aboard');
        assert.equal(email.sender, 'sender@example.com');
        assert.equal(email.recipients, 'a@example.com, b@example.com');
        assert.match(email.content, /Hello world/);
        assert.equal(email.is_read, 0);
        assert.equal('password' in email, false);
        assert.deepEqual(db.listEmails(AUTH.user, 'other password', 10, 0), []);
    });

    test('keeps multi-byte characters intact across stream chunks', async (t) => {
        const { db, port } = await startServer(t);
        // Raw 8-bit message (~170 KB): characters get split between the 64 KB chunks of the stream
        const body = 'Città, naïve café — 日本語 ✓\r\n'.repeat(5000);
        const raw = `Subject: UTF-8\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;
        await sendMail({ port }, AUTH, { raw });
        assert.ok(inbox(db)[0].content.includes(body));
        assert.ok(!inbox(db)[0].content.includes('\uFFFD'));
    });

    test('rejects unauthenticated messages without crashing (was a remote crash)', async (t) => {
        const { db, port } = await startServer(t);
        const replies = await smtpConversation(port, ['EHLO test', 'MAIL FROM:<a@example.com>', 'QUIT']);
        assert.match(replies[0], /^220 /);
        assert.match(replies[2], /^530 /);

        await sendMail({ port }, AUTH);
        assert.equal(inbox(db).length, 1);
    });

    test('rejects empty and overlong credentials', async (t) => {
        const { port } = await startServer(t);
        const replies = await smtpConversation(port, [
            'EHLO test',
            authPlain('x'.repeat(300), 'secret'),
            authPlain('inbox', 'y'.repeat(300)),
            authPlain('inbox', 'secret'),
            'QUIT',
        ]);
        assert.match(replies[2], /^535 /);
        assert.match(replies[3], /^535 /);
        assert.match(replies[4], /^235 /);
    });

    test('rejects messages over the size limit and stores nothing', async (t) => {
        const { db, port } = await startServer(t, { maxMessageBytes: 8 * 1024 });
        await assert.rejects(sendMail({ port }, AUTH, { text: 'x'.repeat(64 * 1024) }), { responseCode: 552 });
        assert.equal(inbox(db).length, 0);

        await sendMail({ port }, AUTH);
        assert.equal(inbox(db).length, 1);
    });

    test('enforces the size limit even when the client does not declare the size', async (t) => {
        const { db, port } = await startServer(t, { maxMessageBytes: 8 * 1024 });
        const replies = await smtpConversation(port, [
            'EHLO test',
            authPlain('inbox', 'secret'),
            'MAIL FROM:<a@example.com>',
            'RCPT TO:<b@example.com>',
            'DATA',
            `Subject: big\r\n\r\n${'x'.repeat(64 * 1024)}\r\n.`,
            'QUIT',
        ]);
        assert.match(replies[5], /^354 /);
        assert.match(replies[6], /^552 /);
        assert.equal(inbox(db).length, 0);
    });

    test('limits the number of recipients', async (t) => {
        const { db, port } = await startServer(t, { maxRecipients: 2 });
        const info = await sendMail({ port }, AUTH, { to: ['a@example.com', 'b@example.com', 'c@example.com'] });
        assert.deepEqual(info.rejected, ['c@example.com']);
        assert.equal(inbox(db)[0].recipients, 'a@example.com, b@example.com');
    });

    test('rate limits messages per client IP', async (t) => {
        const { db, port } = await startServer(t, { rateLimitPerMinute: 2 });
        await sendMail({ port }, AUTH);
        await sendMail({ port }, AUTH);
        await assert.rejects(sendMail({ port }, AUTH), { responseCode: 451 });
        assert.equal(inbox(db).length, 2);
    });

    test('refuses new messages (temporarily) when the storage quota is reached', async (t) => {
        const { db, port, log } = await startServer(t, { maxStorageBytes: 1 });
        await assert.rejects(sendMail({ port }, AUTH), { responseCode: 452 });
        assert.equal(inbox(db).length, 0);
        assert.ok(log.lines.some((line) => line.level === 'warn' && /quota/.test(line.message)));
    });

    test('extracts the subject from the headers only', () => {
        assert.equal(extractSubject('From: a@example.com\r\nSubject: Hello\r\n\r\nbody'), 'Hello');
        assert.equal(extractSubject('SUBJECT: folded\r\n  over lines\r\nTo: b\r\n\r\nbody'), 'folded over lines');
        assert.equal(extractSubject('From: a@example.com\r\n\r\nSubject: not a header'), 'No subject');
        assert.equal(extractSubject('Subject:   \r\n\r\nbody'), 'No subject');
        assert.equal(extractSubject(`Subject: ${'x'.repeat(5000)}\r\n\r\n`).length, 998);
    });
});

describe('SMTP server with implicit TLS', { skip: !hasOpenssl && 'openssl is not installed' }, () => {
    const fingerprint = (pem) => new X509Certificate(pem).fingerprint256;

    const servedFingerprint = (port) =>
        new Promise((resolve, reject) => {
            const socket = tls.connect({ port, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false }, () => {
                resolve(socket.getPeerCertificate().fingerprint256);
                socket.destroy();
            });
            socket.on('error', reject);
        });

    test('serves the configured certificate and hot-reloads renewed ones', async (t) => {
        const dir = tempDir(t);
        const tlsKeyPath = path.join(dir, 'privkey.pem');
        const tlsCertPath = path.join(dir, 'fullchain.pem');
        generateCertificate(tlsKeyPath, tlsCertPath);
        const firstCert = fs.readFileSync(tlsCertPath);

        const { db, port, smtp } = await startServer(t, { secure: true, tlsKeyPath, tlsCertPath });
        assert.equal(await servedFingerprint(port), fingerprint(firstCert));

        // Real client with certificate verification
        await sendMail({ port, secure: true, tls: { ca: firstCert, servername: 'localhost' } }, AUTH);
        assert.equal(inbox(db).length, 1);

        assert.equal(smtp.reloadCertificates(), false, 'unchanged certificate');

        generateCertificate(tlsKeyPath, tlsCertPath); // "renewal"
        assert.equal(smtp.reloadCertificates(), true);
        assert.equal(await servedFingerprint(port), fingerprint(fs.readFileSync(tlsCertPath)));
    });

    test('keeps serving the current certificate if the new one is broken', async (t) => {
        const dir = tempDir(t);
        const tlsKeyPath = path.join(dir, 'privkey.pem');
        const tlsCertPath = path.join(dir, 'fullchain.pem');
        generateCertificate(tlsKeyPath, tlsCertPath);
        const cert = fs.readFileSync(tlsCertPath);

        const { port, smtp, log } = await startServer(t, { secure: true, tlsKeyPath, tlsCertPath });

        // Certificate that does not match the private key
        const other = path.join(dir, 'other');
        generateCertificate(`${other}.key`, `${other}.pem`);
        fs.copyFileSync(`${other}.pem`, tlsCertPath);

        assert.equal(smtp.reloadCertificates(), false);
        assert.ok(log.lines.some((line) => line.level === 'error' && /keeping the current one/.test(line.message)));
        assert.equal(await servedFingerprint(port), fingerprint(cert));
    });
});
