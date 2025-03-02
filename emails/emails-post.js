const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('../emails.sql');

export async function postEmailStats(request, reply) {
    const accounts = request.body;

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
}

export async function postEmailBurn(request, reply) {
    const { username, password } = request.body;

    if (!username || !password) {
        return reply.status(400).send({ error: 'Username and password are required' });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            const query = 'DELETE FROM emails WHERE username = ? AND password = ?';
            db.run(query, [username, password], function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
        if (result === 0) {
            reply.status(404).send({ error: 'No emails found for the given account' });
        } else {
            reply.send({ success: true, deletedEmails: result });
        }
    } catch (err) {
        reply.status(500).send({ error: err.message });
    }
}