import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { buildApi } from '../src/api.js';
import { openDatabase } from '../src/db.js';
import { startRetentionJob } from '../src/retention.js';
import { memoryLog, tempDir, testConfig } from './helpers.js';

const CREDENTIALS = { username: 'inbox', password: 'secret' };
const query = (params) => new URLSearchParams({ ...CREDENTIALS, ...params }).toString();

async function setup(t, apiOverrides = {}, { db: customDb } = {}) {
    const config = testConfig(tempDir(t));
    Object.assign(config.api, apiOverrides);
    const db = customDb ?? openDatabase(config.dbPath);
    const log = memoryLog();
    const app = await buildApi({ db, config: config.api, log });
    t.after(async () => {
        await app.close();
        if (!customDb) db.close();
    });
    return { app, db, log, config };
}

function seed(db, count, { username = 'inbox', password = 'secret' } = {}) {
    return Array.from({ length: count }, (_, i) =>
        db.insertEmail({
            username,
            password,
            sender: 'sender@example.com',
            recipients: 'recipient@example.com',
            subject: `Email ${i + 1}`,
            content: `Subject: Email ${i + 1}\r\n\r\nBody ${i + 1}`,
        }),
    );
}

describe('HTTP API (contract used by the stg-email client)', () => {
    test('GET /emails: newest first, 10 per page, password never returned', async (t) => {
        const { app, db } = await setup(t);
        const ids = seed(db, 12);
        seed(db, 3, { username: 'someone-else' });

        const first = await app.inject({ url: `/emails?${query()}` });
        assert.equal(first.statusCode, 200);
        const emails = first.json();
        assert.deepEqual(emails.map((email) => email.id), ids.slice(2).reverse());
        assert.deepEqual(Object.keys(emails[0]).sort(), [
            'content', 'id', 'is_read', 'recipients', 'sender', 'subject', 'timestamp', 'username',
        ]);

        const second = await app.inject({ url: `/emails?${query({ page: 2 })}` });
        assert.deepEqual(second.json().map((email) => email.id), [ids[1], ids[0]]);

        const wrongPassword = await app.inject({ url: `/emails?${query({ password: 'nope' })}` });
        assert.deepEqual(wrongPassword.json(), []);
    });

    test('GET /emails/:id: returns the email, 404 (not an empty 200) when missing', async (t) => {
        const { app, db } = await setup(t);
        const [id] = seed(db, 1);

        const found = await app.inject({ url: `/emails/${id}?${query()}` });
        assert.equal(found.statusCode, 200);
        assert.equal(found.json().id, id);

        for (const url of [`/emails/${id + 1}?${query()}`, `/emails/${id}?${query({ password: 'nope' })}`]) {
            const missing = await app.inject({ url });
            assert.equal(missing.statusCode, 404);
            assert.deepEqual(missing.json(), { error: 'Email not found' });
        }
    });

    test('GET /emails/delta: emails after `latest`, oldest first, bounded', async (t) => {
        const { app, db } = await setup(t);
        const ids = seed(db, 60);

        const all = await app.inject({ url: `/emails/delta?${query({ latest: 0 })}` });
        assert.deepEqual(all.json().map((email) => email.id), ids.slice(0, 50));

        const newer = await app.inject({ url: `/emails/delta?${query({ latest: ids[57] })}` });
        assert.deepEqual(newer.json().map((email) => email.id), ids.slice(58));
    });

    test('PATCH /emails/read/:id and /emails/read/all', async (t) => {
        const { app, db } = await setup(t);
        const ids = seed(db, 3);

        const read = await app.inject({ method: 'PATCH', url: `/emails/read/${ids[0]}`, payload: CREDENTIALS });
        assert.deepEqual(read.json(), { success: true });
        assert.equal(db.getEmail('inbox', 'secret', ids[0]).is_read, 1);

        const again = await app.inject({ method: 'PATCH', url: `/emails/read/${ids[0]}`, payload: CREDENTIALS });
        assert.deepEqual(again.json(), { success: true }, 'idempotent');

        const otherInbox = await app.inject({
            method: 'PATCH',
            url: `/emails/read/${ids[1]}`,
            payload: { username: 'inbox', password: 'nope' },
        });
        assert.equal(otherInbox.statusCode, 404);

        const all = await app.inject({ method: 'PATCH', url: '/emails/read/all', payload: CREDENTIALS });
        assert.deepEqual(all.json(), { success: true, updated: 2 });
        assert.ok(db.listEmails('inbox', 'secret', 10, 0).every((email) => email.is_read === 1));
    });

    test('POST /emails/stats: one entry per account, matched by username + password', async (t) => {
        const { app, db } = await setup(t);
        seed(db, 2);

        const response = await app.inject({
            method: 'POST',
            url: '/emails/stats',
            payload: [CREDENTIALS, { username: 'empty', password: 'inbox' }],
        });
        assert.equal(response.statusCode, 200);
        const [full, empty] = response.json();
        assert.equal(full.username, 'inbox');
        assert.equal(full.password, 'secret');
        assert.equal(full.totalEmails, 2);
        assert.match(full.lastEmailDate, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
        assert.deepEqual(empty, { username: 'empty', password: 'inbox', totalEmails: 0, lastEmailDate: null });
    });

    test('POST /emails/burn: deletes the inbox, 404 when already empty', async (t) => {
        const { app, db } = await setup(t);
        seed(db, 3);
        seed(db, 1, { username: 'someone-else' });

        const burn = await app.inject({ method: 'POST', url: '/emails/burn', payload: CREDENTIALS });
        assert.deepEqual(burn.json(), { success: true, deletedEmails: 3 });
        assert.equal(db.inboxStats('someone-else', 'secret').totalEmails, 1);

        const again = await app.inject({ method: 'POST', url: '/emails/burn', payload: CREDENTIALS });
        assert.equal(again.statusCode, 404);
    });
});

describe('HTTP API hardening', () => {
    test('rejects invalid input with 400 and never leaks database errors', async (t) => {
        const { app } = await setup(t);
        const requests = [
            { url: '/emails' },
            { url: '/emails?username=inbox' },
            { url: `/emails?${query({ page: 'abc' })}` }, // was "SQLITE_MISMATCH: datatype mismatch"
            { url: `/emails?${query({ page: 0 })}` },
            { url: '/emails?username=a&username=b&password=c' },
            { url: `/emails?${query({ username: 'x'.repeat(300) })}` },
            { url: `/emails/abc?${query()}` },
            { url: `/emails/delta?${query()}` },
            { url: `/emails/delta?${query({ latest: -1 })}` },
            { method: 'PATCH', url: '/emails/read/1', payload: { username: 'inbox' } },
            { method: 'PATCH', url: '/emails/read/1', payload: { username: { $ne: 1 }, password: 'x' } },
            { method: 'POST', url: '/emails/stats', payload: [] },
            { method: 'POST', url: '/emails/stats', payload: CREDENTIALS },
            { method: 'POST', url: '/emails/stats', payload: [{ username: { a: 1 }, password: 'x' }] },
            { method: 'POST', url: '/emails/stats', payload: Array(101).fill(CREDENTIALS) }, // 1 request = 101 queries
            { method: 'POST', url: '/emails/burn', payload: 'not json', headers: { 'content-type': 'application/json' } },
        ];
        for (const request of requests) {
            const response = await app.inject(request);
            const label = `${request.method ?? 'GET'} ${request.url}`;
            assert.equal(response.statusCode, 400, label);
            assert.equal(typeof response.json().error, 'string', label);
            assert.doesNotMatch(response.body, /sqlite/i, label);
        }
    });

    test('rejects oversized bodies', async (t) => {
        const { app } = await setup(t);
        const payload = [{ username: 'inbox', password: 'x'.repeat(200 * 1024) }];
        const response = await app.inject({ method: 'POST', url: '/emails/stats', payload });
        assert.equal(response.statusCode, 413);
    });

    test('hides internal errors from clients but logs them', async (t) => {
        const failingDb = {
            listEmails() {
                throw new Error('SQLITE_CORRUPT: database disk image is malformed');
            },
        };
        const { app, log } = await setup(t, {}, { db: failingDb });
        const response = await app.inject({ url: `/emails?${query()}` });
        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.json(), { error: 'Internal server error' });
        assert.ok(log.lines.some((line) => line.level === 'error' && /SQLITE_CORRUPT/.test(line.detail.message)));
    });

    test('unknown routes return a generic 404 without echoing the URL', async (t) => {
        const { app } = await setup(t);
        const response = await app.inject({ url: `/admin?${query()}` });
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.json(), { error: 'Not found' });
    });

    test('responses are not cacheable and not sniffable', async (t) => {
        const { app } = await setup(t);
        for (const url of [`/emails?${query()}`, '/emails', '/nope']) {
            const response = await app.inject({ url });
            assert.equal(response.headers['cache-control'], 'no-store', url);
            assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
        }
    });

    test('CORS: PATCH is allowed in preflights (@fastify/cors 11 default would drop it)', async (t) => {
        const { app } = await setup(t);
        const response = await app.inject({
            method: 'OPTIONS',
            url: '/emails/read/1',
            headers: {
                origin: 'https://wincisky.github.io',
                'access-control-request-method': 'PATCH',
                'access-control-request-headers': 'content-type',
            },
        });
        assert.equal(response.statusCode, 204);
        assert.equal(response.headers['access-control-allow-origin'], '*');
        assert.match(response.headers['access-control-allow-methods'], /PATCH/);
    });

    test('CORS can be restricted to known origins', async (t) => {
        const { app } = await setup(t, { corsOrigin: ['https://wincisky.github.io'] });
        const allowed = await app.inject({ url: '/emails', headers: { origin: 'https://wincisky.github.io' } });
        assert.equal(allowed.headers['access-control-allow-origin'], 'https://wincisky.github.io');
        const denied = await app.inject({ url: '/emails', headers: { origin: 'https://evil.example' } });
        assert.equal(denied.headers['access-control-allow-origin'], undefined);
    });

    test('rate limits per client IP, using X-Forwarded-For only from the local proxy', async (t) => {
        const { app } = await setup(t, { rateLimitPerMinute: 3 });
        const url = `/emails?${query()}`;
        const hit = (remoteAddress, headers = {}) => app.inject({ url, remoteAddress, headers });

        for (let i = 0; i < 3; i++) assert.equal((await hit('203.0.113.7')).statusCode, 200);
        const limited = await hit('203.0.113.7');
        assert.equal(limited.statusCode, 429);
        assert.ok(limited.headers['retry-after']);
        assert.equal(typeof limited.json().error, 'string');

        // A spoofed X-Forwarded-For from an untrusted client doesn't reset its limit
        assert.equal((await hit('203.0.113.7', { 'x-forwarded-for': '198.51.100.99' })).statusCode, 429);
        // Other clients are unaffected
        assert.equal((await hit('203.0.113.8')).statusCode, 200);

        // Behind nginx: the client is identified by X-Forwarded-For
        const viaProxy = { 'x-forwarded-for': '198.51.100.1' };
        for (let i = 0; i < 3; i++) assert.equal((await hit('127.0.0.1', viaProxy)).statusCode, 200);
        assert.equal((await hit('127.0.0.1', viaProxy)).statusCode, 429);

        // Loopback without X-Forwarded-For (proxy not forwarding it, local tools) isn't limited
        for (let i = 0; i < 5; i++) assert.equal((await hit('127.0.0.1')).statusCode, 200);
    });
});

describe('Database', () => {
    test('is only readable by its owner (it holds emails and credentials)', async (t) => {
        const config = testConfig(tempDir(t));
        fs.writeFileSync(config.dbPath, '', { mode: 0o644 }); // e.g. created by the old version
        const db = openDatabase(config.dbPath);
        t.after(() => db.close());
        seed(db, 1);
        for (const file of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
        }
    });

    test('migrates a database created by the old version', async (t) => {
        const config = testConfig(tempDir(t));
        const legacy = new DatabaseSync(config.dbPath);
        legacy.exec(`CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password TEXT,
            sender TEXT, recipients TEXT, subject TEXT, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        legacy.prepare('INSERT INTO emails (username, password, content) VALUES (?, ?, ?)').run('inbox', 'secret', 'raw');
        legacy.close();

        const { app } = await setup(t, {}, { db: openDatabase(config.dbPath) });
        const [email] = (await app.inject({ url: `/emails?${query()}` })).json();
        assert.equal(email.content, 'raw');
        assert.equal(email.is_read, 0);
    });

    test('retention deletes old emails in batches (the old cron never ran)', async (t) => {
        const config = testConfig(tempDir(t));
        const db = openDatabase(config.dbPath);
        t.after(() => db.close());
        seed(db, 1203);
        const raw = new DatabaseSync(config.dbPath);
        raw.exec("UPDATE emails SET timestamp = datetime('now', '-31 days') WHERE id <= 1200");
        raw.close();

        assert.equal(await db.purgeOlderThan(30), 1200);
        assert.equal(db.inboxStats('inbox', 'secret').totalEmails, 3);

        seed(db, 2);
        const raw2 = new DatabaseSync(config.dbPath);
        raw2.exec("UPDATE emails SET timestamp = datetime('now', '-40 days') WHERE id > 1203");
        raw2.close();
        const log = memoryLog();
        const job = startRetentionJob({ db, retentionDays: 30, log });
        t.after(() => job.stop());
        await nextTick();
        assert.equal(db.inboxStats('inbox', 'secret').totalEmails, 3);
        assert.ok(log.lines.some((line) => /Deleted 2 email/.test(line.message)));
    });
});
