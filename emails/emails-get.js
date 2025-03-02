import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('emails.sql');

export async function getEmails(request, reply) {
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
}

export async function getDeltaEmails(request, reply) {
    const { username, password, latest } = request.query;

    if (!username || !password || !latest) {
        return reply.status(400).send({ error: 'Username, password, and latest are required' });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            // get emails since the latest email id
            const query = 'SELECT * FROM emails WHERE username = ? AND password = ? AND id > ?';
            db.all(query, [username, password, latest], (err, rows) => {
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
}