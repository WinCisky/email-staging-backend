const { getEmails } = require('./emails/emails-get');
const { patchReadEmail } = require('./emails/emails-patch');
const { postEmailStats, postEmailBurn } = require('./emails/emails-post');

// Require the framework and instantiate it
const fastify = require('fastify')({ logger: false })

// Register the @fastify/cors plugin
fastify.register(require('@fastify/cors'), {
  origin: '*' // Allow all origins
})

// Declare a route
fastify.get('/emails', async function handler(request, reply) {
  await getEmails(request, reply);
});

fastify.patch('/emails/read/:id', async function handler(request, reply) {
  await patchReadEmail(request, reply);
});

fastify.post('/emails/stats', async function handler(request, reply) {
  await postEmailStats(request, reply);
});

fastify.post('/emails/burn', async function handler(request, reply) {
  await postEmailBurn(request, reply);
});

// Run the server!
fastify.listen({ port: 3628 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
