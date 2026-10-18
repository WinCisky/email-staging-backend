# Security audit – October 2026

Scope: this repository (SMTP server + HTTP API) as deployed with pm2 on a VPS, behind nginx, with the
[stg-email](https://github.com/WinCisky/stg-email) web client. Target runtime: Node.js 24 LTS.

Every finding marked *verified* was reproduced against the previous version; every fix is covered by
`npm test` (unit, API and end-to-end tests that spawn the real processes).

## Findings and fixes

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | **Critical** | **Remote crash before authentication** (*verified*): any client sending a message without SMTP AUTH made `onData` read `session.credentials.username` of `undefined`; the exception killed the SMTP process. Trivial to repeat forever. | AUTH is mandatory (`530` otherwise); the data handler never throws (errors become SMTP `451` replies). |
| 2 | **High** | **Unbounded memory per message**: no size limit, the whole message was accumulated in a string → one client could exhaust the RAM. | `SMTP_MAX_MESSAGE_MB` (10 MiB) enforced while streaming, `552` reply; at most 20 clients (`SMTP_MAX_CLIENTS`), 50 recipients. |
| 3 | **High** | **22 known vulnerabilities in dependencies** (2 critical, 15 high), among them `smtp-server` command-parser memory exhaustion (GHSA-fv2f-rw9f-v9cm), several `fastify` validation bypasses, `nodemailer`, and `tar`/`node-gyp` pulled by the native `sqlite3` addon. Lockfile out of sync (`npm ci` impossible). | All dependencies updated, `sqlite3` replaced by Node's built-in `node:sqlite`, `node-cron` and `require-in-the-middle` removed: 57 production packages, `npm audit`: 0. Lockfile regenerated. |
| 4 | **High** | **Unbounded disk usage** (*verified*): the cleanup cron never ran (`deleteOldEmails` not imported, non-existent `created_at` column, double-quoted SQL strings) → emails and spam kept forever. | Hourly retention job (batched, indexed), plus a storage quota (`MAX_STORAGE_MB`, `452` = retry later) and a per-IP message rate limit. |
| 5 | Medium | **Database world-readable** (*verified*, mode `644`): it holds every email and the inbox passwords in clear. | `umask 077`; existing files (and `-wal`/`-shm`) are tightened to `600` at startup. |
| 6 | Medium | **No input validation**; database errors returned to clients (*verified*: `?page=abc` → `SQLITE_MISMATCH: datatype mismatch`); objects accepted as SQL parameters. | JSON schemas on every route (types, lengths 1–256, integer ids/pages); generic `500` responses, details only in the logs. |
| 7 | Medium | **Request amplification** (*verified*): `POST /emails/stats` accepted any array (1 request with 20,000 accounts = 20,000 queries); `/emails/delta` returned whole inboxes. | Max 100 accounts per request, 64 KiB body limit, delta capped (50 emails / ~20 MB per call, the client fetches the rest at the next poll). |
| 8 | Medium | **No rate limiting** on the API (credential guessing, scraping, DoS) nor on SMTP. | 300 req/min per client IP (`API_RATE_LIMIT`); `X-Forwarded-For` trusted only from the local proxy, so it can't be spoofed. 120 msg/min per IP on SMTP. |
| 9 | Medium | **Processes probably running as root** (needed to read the Let's Encrypt private key): a compromise would own the server. | Documented unprivileged setup (dedicated user, certbot deploy hook copying the certificate); warning in the logs when running as root. |
| 10 | Medium | **Expired certificate after renewal**: the TLS key/certificate were read once at startup. | Re-read every 6 h (or on `SIGHUP`), validated before use (a broken file can't take the server down), expiry warning 7 days ahead. |
| 11 | Low | **Silent failures**: SMTP errors were swallowed, including listen errors → pm2 showed "online" while nothing listened. | Startup errors (port in use, unreadable certificate, invalid configuration) exit with code 1 and a clear message; runtime errors are logged. |
| 12 | Low | Inbox password echoed in every email returned by the API (`SELECT *`). | Explicit column list (the stats endpoint still echoes the credentials it receives: the client matches on them). |
| 13 | Low | No graceful shutdown: pm2 kills processes 1.6 s after `SIGINT`. | `SIGINT`/`SIGTERM` handling (stop accepting, finish sessions, close the DB); `kill_timeout` 15 s. |
| 14 | Low | Database path relative to the working directory: starting pm2 elsewhere silently used another, empty database. | Paths resolved from the project directory. |
| 15 | Low | API responses cacheable by browsers/proxies. | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. |
| 16 | Low | `client.js` disabled TLS certificate verification (and was broken: CommonJS in an ES module package). | Rewritten; verification on by default. |
| 17 | Info | Native addon + install scripts: `sqlite3` needs a prebuilt download or a compiler, and is blocked by default by pnpm ≥ 10 / npm `allowScripts`. | No native modules any more; `.npmrc` sets `ignore-scripts=true` and `engine-strict=true`. |

Other bugs fixed on the way: multi-byte characters corrupted when split between stream chunks; `GET /emails/:id`
answered `200` with an empty body for missing emails (now `404`); unstable pagination for emails received in
the same second; the subject could be read from the message body; with `@fastify/cors` 11 the browser
preflight would have rejected the `PATCH` requests of the client.

## Accepted risks (by design)

- **Anyone can create an inbox**: any SMTP credentials are accepted and identify an inbox, and knowing them is
  enough to read it. Use long random credentials per project, never real passwords, and remember that weak
  ones (`test`/`test`) can be guessed. The rate limits make guessing slow, not impossible.
- **Inbox passwords are stored in clear**: they are lookup keys, not user passwords (hashing them would not
  protect the emails, which are in the same database).
- **Credentials in query strings**: required by the current client (`GET /emails?username=…&password=…`).
  They don't reach this app's logs; configure nginx as shown in the README so they don't reach its access log.
- **CORS `*`**: the API uses no cookies or other ambient credentials, so other origins can't do anything they
  couldn't do directly; restrict it anyway with `CORS_ORIGIN` if you like.

## Recommendations outside this repository

- **stg-email (web client)**:
  - email HTML is rendered with `innerHTML` in a shadow root: event handlers such as `<img onerror>` run in the
    app's origin and can read every saved inbox credential from `localStorage`. Render it in a sandboxed
    iframe (`<iframe sandbox srcdoc>` without `allow-scripts`);
  - on API errors the inbox username *and password* are sent to PostHog: drop the password;
  - credentials are put in URLs without `encodeURIComponent` (passwords with `&`, `#`, `+` break): better,
    move them to an `Authorization` header (needs a matching API change).
- **VPS**: dedicated user, firewall (no public 3628), `pm2-logrotate`, unattended security upgrades, keep
  Node.js on the latest 24.x patch (`nvm install 24 --reinstall-packages-from=current`; Node 26, due to become
  LTS in October 2026, already passes the test suite), `server_tokens off` in nginx (it currently advertises
  `nginx/1.24.0 (Ubuntu)`).
