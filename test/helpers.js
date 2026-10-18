import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.js';

export const AUTH = { user: 'inbox', pass: 'secret' };

/** Logger that keeps the lines in memory instead of printing them. */
export function memoryLog() {
    const lines = [];
    const write = (level) => (message, detail) => lines.push({ level, message, detail });
    return { lines, debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

export function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-staging-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

export function testConfig(dir, env = {}) {
    return loadConfig({
        DB_PATH: path.join(dir, 'emails.sql'),
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '0',
        SMTP_SECURE: 'false',
        API_HOST: '127.0.0.1',
        API_PORT: '0',
        ...env,
    });
}

export async function sendMail({ port, secure = false, tls }, auth, message = {}) {
    const transporter = nodemailer.createTransport({ host: '127.0.0.1', port, secure, tls, auth, ignoreTLS: !secure });
    try {
        return await transporter.sendMail({
            from: 'sender@example.com',
            to: 'recipient@example.com',
            subject: 'Test message',
            text: 'Hello world',
            ...message,
        });
    } finally {
        transporter.close();
    }
}

/** Raw SMTP dialogue: sends each command after the previous reply, returns the final reply lines. */
export function smtpConversation(port, commands) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const queue = [...commands];
        const replies = [];
        let buffer = '';
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy(new Error('SMTP conversation timed out')));
        socket.on('data', (data) => {
            buffer += data;
            let end;
            while ((end = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (/^\d{3}-/.test(line)) continue; // continuation of a multi-line reply
                replies.push(line);
                if (queue.length > 0) socket.write(`${queue.shift()}\r\n`);
                else socket.end();
            }
        });
        socket.on('close', () => resolve(replies));
        socket.on('error', reject);
    });
}

export const hasOpenssl = (() => {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

export function generateCertificate(keyPath, certPath) {
    execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
            '-keyout', keyPath, '-out', certPath],
        { stdio: 'ignore' },
    );
}
