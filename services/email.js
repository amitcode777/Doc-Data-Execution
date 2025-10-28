// services/email.js
import nodemailer from 'nodemailer';
import config from '../config/index.js';

export const sendEmailWithAttachments = async (to, subject, message, attachments = []) => {
    if (!config.EMAIL_CONFIG.host || !config.EMAIL_CONFIG.auth.user || !config.EMAIL_CONFIG.auth.pass) {
        throw new Error('Email configuration missing');
    }

    const transporter = nodemailer.createTransport(config.EMAIL_CONFIG);

    const mailOptions = {
        from: `"Document Analysis" <${config.EMAIL_CONFIG.auth.user}>`,
        to,
        subject,
        html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>${subject}</h2><p>${message}</p>
      <p>Attachments: ${attachments.length}</p>
      <small>Automated message from Document Analysis System</small>
    </div>`,
        attachments
    };

    return await transporter.sendMail(mailOptions);
};

export default {
    sendEmailWithAttachments
};