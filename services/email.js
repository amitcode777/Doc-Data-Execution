// services/email.js
import nodemailer from 'nodemailer';
import fs from 'fs';
import config from '../config/index.js';

export const sendEmailWithAttachments = async (to, subject, message, attachments = []) => {
  if (!config.EMAIL_CONFIG.host || !config.EMAIL_CONFIG.auth.user || !config.EMAIL_CONFIG.auth.pass) {
    throw new Error('Email configuration missing');
  }

  const MAX_SIZE_PER_EMAIL = 4 * 1024 * 1024; // 4MB max per email
  const MAX_TOTAL_ATTACHMENTS = 5; // Limit total attachments for Vercel

  const transporter = nodemailer.createTransport(config.EMAIL_CONFIG);

  // Filter out invalid attachments and limit total
  const validAttachments = attachments
    .filter(attachment => {
      try {
        return fs.existsSync(attachment.path);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_TOTAL_ATTACHMENTS);

  if (validAttachments.length === 0) {
    throw new Error('No valid attachments found');
  }

  // Split attachments into chunks based on size
  const emailChunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const attachment of validAttachments) {
    try {
      const fileSize = fs.statSync(attachment.path).size;

      if (currentSize + fileSize > MAX_SIZE_PER_EMAIL && currentChunk.length > 0) {
        emailChunks.push([...currentChunk]);
        currentChunk = [attachment];
        currentSize = fileSize;
      } else {
        currentChunk.push(attachment);
        currentSize += fileSize;
      }
    } catch (error) {
      console.error(`Error reading file: ${attachment.filename}`);
    }
  }

  if (currentChunk.length > 0) {
    emailChunks.push(currentChunk);
  }

  // Send emails
  const results = [];

  for (let i = 0; i < emailChunks.length; i++) {
    const chunk = emailChunks[i];
    const emailSubject = emailChunks.length > 1 ? `${subject} (${i + 1}/${emailChunks.length})` : subject;

    const mailOptions = {
      from: `"Document Analysis" <${config.EMAIL_CONFIG.auth.user}>`,
      to,
      subject: emailSubject,
      html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>${emailSubject}</h2>
        <p>${message}</p>
        <p>Files attached: ${chunk.length}</p>
        <small>Automated message from Document Analysis System</small>
      </div>`,
      attachments: chunk
    };

    try {
      const result = await transporter.sendMail(mailOptions);
      results.push(result);
    } catch (error) {
      console.error(`Failed to send email part ${i + 1}:`, error);
      throw error; // Re-throw to handle in the main catch block
    }
  }

  return {
    emailsSent: results.length,
    totalAttachments: validAttachments.length
  };
};

export default {
  sendEmailWithAttachments
};