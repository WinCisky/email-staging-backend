// Development helper: sends a test email to the mock SMTP server.
//
//   npm run send-test-email -- [username] [password]
//
// Targets the local dev server (npm run dev) by default.
// For another server set SMTP_HOST, SMTP_PORT and SMTP_SECURE=true (implicit TLS, certificate verified).
import nodemailer from 'nodemailer';

const [username = 'your_username1', password = 'your_password2'] = process.argv.slice(2);

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 2525),
    secure: /^(1|true|yes|on)$/i.test(process.env.SMTP_SECURE ?? 'false'),
    auth: { user: username, pass: password },
});

try {
    const info = await transporter.sendMail({
        from: '"Sender Name" <sender@example.com>',
        to: 'recipient@example.com',
        subject: 'Hello',
        text: 'Hello world?',
        html: '<b>Hello world?</b>',
    });
    console.log('Message sent: %s', info.messageId);
} catch (err) {
    console.error('Could not send the message:', err.message);
    process.exitCode = 1;
}
