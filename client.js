const nodemailer = require('nodemailer');

// Create a transporter object using the SMTP server details
let transporter = nodemailer.createTransport({
    host: 'localhost', // Replace with your SMTP server host
    port: 2525, // Replace with your SMTP server port
    secure: false, // true for 465, false for other ports
    auth: {
        user: 'your_username1', // Replace with your SMTP username
        pass: 'your_password2'  // Replace with your SMTP password
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Set up email data
let mailOptions = {
    from: '"Sender Name" <sender@example.com>', // Sender address
    to: 'recipient@example.com', // List of recipients
    subject: 'Hello', // Subject line
    text: 'Hello world?', // Plain text body
    html: '<b>Hello world?</b>' // HTML body
};

// Send mail with defined transport object
transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
        return console.log(error);
    }
    console.log('Message sent: %s', info.messageId);
});