const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('emails.sql');

// Require the framework and instantiate it
const fastify = require('fastify')({ logger: false })

// Register the @fastify/cors plugin
fastify.register(require('@fastify/cors'), { 
  origin: '*' // Allow all origins
})

// Declare a route
fastify.get('/emails', async function handler (request, reply) {
  const { username, password, page = 1 } = request.query;
  const pageSize = 10; // Number of results per page
  const offset = (page - 1) * pageSize;

  if (!username || !password) {
    return reply.status(400).send({ error: 'Username and password are required' });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const query = 'SELECT * FROM emails WHERE username = ? AND password = ? LIMIT ? OFFSET ?';
      db.all(query, [username, password, pageSize, offset], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
    reply.send(result);
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

// Run the server!
fastify.listen({ port: 3000 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})