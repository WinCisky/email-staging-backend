import fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { getEmails, getEmail, getDeltaEmails } from './emails/emails-get.js';
import { patchReadAllEmails, patchReadEmail } from './emails/emails-patch.js';
import { postEmailStats, postEmailBurn } from './emails/emails-post.js';

const app = fastify({ logger: false });

app.register(cors, {
  origin: '*' // Allow all origins
});

app.get('/emails', async (request, reply) => {
  await getEmails(request, reply);
});

app.get('/emails/:id', async (request, reply) => {
  await getEmail(request, reply);
});

app.get('/emails/delta', async (request, reply) => {
  await getDeltaEmails(request, reply);
});

app.patch('/emails/read/:id', async (request, reply) => {
  await patchReadEmail(request, reply);
});

app.patch('/emails/read/all', async (request, reply) => {
  await patchReadAllEmails(request, reply);
});

app.post('/emails/stats', async (request, reply) => {
  await postEmailStats(request, reply);
});

app.post('/emails/burn', async (request, reply) => {
  await postEmailBurn(request, reply);
});

cron.schedule('0 0 * * *', async () => {
  try {
    await deleteOldEmails();
  } catch (error) {
    console.error('Error deleting old emails:', error);
  }
});

app.listen({ port: 3628 }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
