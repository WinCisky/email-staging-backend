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
      const query = 'SELECT * FROM emails WHERE username = ? AND password = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?';
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

fastify.patch('/emails/read/:id', async function handler (request, reply) {
  const { id } = request.params;
  const { username, password } = request.query;

  if (!username || !password) {
    return reply.status(400).send({ error: 'Username and password are required' });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const query = 'UPDATE emails SET is_read = 1 WHERE id = ? AND username = ? AND password = ?';
      db.run(query, [id, username, password], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
    if (result === 0) {
      reply.status(404).send({ error: 'Email not found' });
    } else {
      reply.send({ success: true });
    }
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

fastify.post('/emails/stats', async function handler (request, reply) {
  const accounts = request.body.accounts;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return reply.status(400).send({ error: 'Accounts array is required' });
  }

  try {
    const results = await Promise.all(accounts.map(account => {
      const { username, password } = account;
      return new Promise((resolve, reject) => {
        const query = `
          SELECT COUNT(*) as totalEmails, MAX(timestamp) as lastEmailDate
          FROM emails
          WHERE username = ? AND password = ?
        `;
        db.get(query, [username, password], (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve({ username, password, totalEmails: row.totalEmails, lastEmailDate: row.lastEmailDate });
          }
        });
      });
    }));

    reply.send(results);
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

// Run the server!
fastify.listen({ port: 3628 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
