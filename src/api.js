import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { MAX_CREDENTIAL_LENGTH } from './config.js';
import { PAGE_SIZE } from './db.js';

const MAX_STATS_ACCOUNTS = 100;

// Requests from loopback without X-Forwarded-For can't be told apart (they all look like the proxy):
// they are not rate limited, so a misconfigured proxy can't make everybody share one limit
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const credential = { type: 'string', minLength: 1, maxLength: MAX_CREDENTIAL_LENGTH };
const credentialProperties = { username: credential, password: credential };
const credentials = { type: 'object', required: ['username', 'password'], properties: credentialProperties };
const emailId = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
};

/**
 * HTTP API used by the web client (stg-email) to read the inboxes.
 * An inbox is identified by the SMTP username + password used to send the emails.
 */
export async function buildApi({ db, config, log }) {
    const app = Fastify({
        logger: false, // request logs would contain the credentials sent in query strings
        trustProxy: config.trustProxy,
        bodyLimit: 64 * 1024,
        requestTimeout: 30_000,
    });

    app.setErrorHandler((error, request, reply) => {
        const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
        if (status >= 500) {
            log.error(`${request.method} ${request.routeOptions.url ?? 'unknown route'} failed`, error);
            return reply.code(500).send({ error: 'Internal server error' }); // never leak internals
        }
        return reply.code(status).send({ error: error.message });
    });

    const rateLimited = config.rateLimitPerMinute > 0;
    if (rateLimited) {
        await app.register(rateLimit, {
            max: config.rateLimitPerMinute,
            timeWindow: 60_000,
            allowList: (request, key) => LOOPBACK.has(key),
        });
    }

    await app.register(cors, {
        origin: config.corsOrigin,
        // @fastify/cors >= 11 only allows GET, HEAD and POST by default
        methods: ['GET', 'POST', 'PATCH'],
        maxAge: 600, // cache preflight responses: fewer OPTIONS requests
    });

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('cache-control', 'no-store'); // responses contain private emails
        reply.header('x-content-type-options', 'nosniff');
        return payload;
    });

    app.setNotFoundHandler(rateLimited ? { preHandler: app.rateLimit() } : {}, (request, reply) =>
        reply.code(404).send({ error: 'Not found' }),
    );

    app.get(
        '/emails',
        {
            schema: {
                querystring: {
                    type: 'object',
                    required: ['username', 'password'],
                    properties: {
                        ...credentialProperties,
                        page: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 },
                    },
                },
            },
        },
        async (request) => {
            const { username, password, page } = request.query;
            return db.listEmails(username, password, PAGE_SIZE, (page - 1) * PAGE_SIZE);
        },
    );

    app.get(
        '/emails/delta',
        {
            schema: {
                querystring: {
                    type: 'object',
                    required: ['username', 'password', 'latest'],
                    properties: {
                        ...credentialProperties,
                        latest: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                    },
                },
            },
        },
        async (request) => {
            const { username, password, latest } = request.query;
            return db.listEmailsAfter(username, password, latest);
        },
    );

    app.get('/emails/:id', { schema: { params: emailId, querystring: credentials } }, async (request, reply) => {
        const { username, password } = request.query;
        const email = db.getEmail(username, password, request.params.id);
        if (!email) return reply.code(404).send({ error: 'Email not found' });
        return email;
    });

    app.patch('/emails/read/all', { schema: { body: credentials } }, async (request) => {
        const { username, password } = request.body;
        return { success: true, updated: db.markAllRead(username, password) };
    });

    app.patch('/emails/read/:id', { schema: { params: emailId, body: credentials } }, async (request, reply) => {
        const { username, password } = request.body;
        if (db.markRead(username, password, request.params.id) === 0) {
            return reply.code(404).send({ error: 'Email not found' });
        }
        return { success: true };
    });

    app.post(
        '/emails/stats',
        { schema: { body: { type: 'array', minItems: 1, maxItems: MAX_STATS_ACCOUNTS, items: credentials } } },
        async (request) =>
            request.body.map(({ username, password }) => ({
                username,
                password,
                ...db.inboxStats(username, password),
            })),
    );

    app.post('/emails/burn', { schema: { body: credentials } }, async (request, reply) => {
        const { username, password } = request.body;
        const deletedEmails = db.burnInbox(username, password);
        if (deletedEmails === 0) {
            return reply.code(404).send({ error: 'No emails found for the given account' });
        }
        return { success: true, deletedEmails };
    });

    return app;
}
