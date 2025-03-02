import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('emails.sql');

export async function patchReadEmail(request, reply) {
    const { id } = request.params;
    const { username, password } = request.body;

    if (!username || !password) {
        return reply.status(400).send({ error: 'Username and password are required' });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            const query = 'UPDATE emails SET is_read = 1 WHERE id = ? AND username = ? AND password = ?';
            db.run(query, [id, username, password], function (err) {
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
}