const fs = require('fs');
const { SMTPServer } = require('smtp-server');
const sqlite3 = require('sqlite3');

// Create or open the SQLite database
const db = new sqlite3.Database('./emails.sql', (err) => {
    if (err) {
        console.error("Error opening SQLite database", err);
    } else {
        console.log("Connected to SQLite database");
    }
});

// Create the emails table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    password TEXT,
    sender TEXT,
    recipients TEXT,
    subject TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read BOOLEAN DEFAULT 0
  )
`);

// Check if the is_read column exists, and add it if it doesn't
db.get("PRAGMA table_info(emails)", (err, columns) => {
    if (err) {
        console.error("Error checking table info:", err);
    } else {
        const columnNames = columns.map(column => column.name);
        if (!columnNames.includes('is_read')) {
            db.run("ALTER TABLE emails ADD COLUMN is_read BOOLEAN DEFAULT 0", (err) => {
                if (err) {
                    console.error("Error adding is_read column:", err);
                } else {
                    console.log("is_read column added to emails table");
                }
            });
        }
    }
});

const server = new SMTPServer({
    secure: true,
    key: fs.readFileSync("/etc/letsencrypt/live/test.opentrust.it/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/test.opentrust.it/fullchain.pem"),
    authOptional: true,
    allowInsecureAuth: true,
    onData(stream, session, callback) {
        let emailData = '';

        stream.on('data', chunk => {
            emailData += chunk;
        });

        stream.on('end', () => {
            console.log('Email received');

            const credentials = session.credentials;

            // Parse the email content
            const sender = session.envelope.mailFrom.address;
            const recipients = session.envelope.rcptTo.map(rcpt => rcpt.address).join(', ');
            const subject = emailData.match(/Subject: (.*)/)?.[1] || 'No subject';
            const content = emailData;

            // Insert email into SQLite
            const stmt = db.prepare("INSERT INTO emails (username, password, sender, recipients, subject, content) VALUES (?, ?, ?, ?, ?, ?)");
            stmt.run(credentials.username, credentials.password, sender, recipients, subject, content, function (err) {
                if (err) {
                    console.error("Error inserting email into SQLite:", err);
                } else {
                    console.log("Email saved to SQLite");
                }
            });
            stmt.finalize();

            callback(); // Signal completion
        });
    },

    onAuth(auth, session, callback) {
        const username = auth.username;
        const password = auth.password;
        // store the username and password in the session
        session.credentials = { username, password };
        callback(null, { user: auth.username });
    },

    // Handle SMTP session details
    onConnect(session, callback) {
        console.log('Client connected');
        callback();
    },

    onMailFrom(address, session, callback) {
        console.log(`Mail from: ${address.address}`);
        callback();
    },

    onRcptTo(address, session, callback) {
        console.log(`Mail to: ${address.address}`);
        callback();
    },

    onQuit(callback) {
        console.log('Client disconnected');
        callback();
    }
});

// Gestore di errori per catturare eventuali errori TLS
server.on('error', (err) => {
    console.error('SMTP Server Error:', err);
});

// Start the mock SMTP server on port 2525
server.listen(465, () => {
    console.log('SMTP server listening on port 2525');
});
