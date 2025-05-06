import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('emails.sql');

export async function deleteOldEmails() {
    const query = 'DELETE FROM emails WHERE created_at < datetime("now", "-30 days")';
    return new Promise((resolve, reject) => {
        db.run(query, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}