// services/email.js
import nodemailer from 'nodemailer';
import fs from 'fs';
import config from '../config/index.js';


export const sendEmailWithAttachments = async (to, subject, message, attachments = []) => {
  if (!config.EMAIL_CONFIG.host || !config.EMAIL_CONFIG.auth.user || !config.EMAIL_CONFIG.auth.pass) {
    throw new Error('Email configuration missing');
  }

  // REDUCE THIS - account for email overhead
  const MAX_SIZE_PER_EMAIL = 24 * 1024 * 1024; // 3.5MB instead of 4MB
  const DELAY_BETWEEN_EMAILS = 1000; // 0.5 seconds
  
  const transporter = nodemailer.createTransport(config.EMAIL_CONFIG);

  console.log(`📧 Processing ${attachments.length} attachments`);

  // Split attachments into chunks with smaller size limit
  const emailChunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const attachment of attachments) {
    try {
      const fileSize = fs.statSync(attachment.path).size;
      const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
      
      console.log(`📄 ${attachment.filename}: ${fileSizeMB}MB`);
      
      // If single file is too large, skip it
      if (fileSize > MAX_SIZE_PER_EMAIL) {
        console.log(`❌ Skipping ${attachment.filename} - too large (${fileSizeMB}MB)`);
        continue;
      }
      
      // Check if adding this file would exceed limit
      if (currentSize + fileSize > MAX_SIZE_PER_EMAIL && currentChunk.length > 0) {
        console.log(`📦 Created chunk ${emailChunks.length + 1} with ${currentChunk.length} files (${(currentSize / 1024 / 1024).toFixed(2)}MB)`);
        emailChunks.push([...currentChunk]);
        currentChunk = [attachment];
        currentSize = fileSize;
      } else {
        currentChunk.push(attachment);
        currentSize += fileSize;
      }
    } catch (error) {
      console.error(`Error reading file: ${attachment.filename}`, error);
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    console.log(`📦 Created final chunk ${emailChunks.length + 1} with ${currentChunk.length} files (${(currentSize / 1024 / 1024).toFixed(2)}MB)`);
    emailChunks.push(currentChunk);
  }

  console.log(`📨 Total chunks: ${emailChunks.length}`);

  // Send emails
  const results = [];
  
  for (let i = 0; i < emailChunks.length; i++) {
    const chunk = emailChunks[i];
    const chunkSizeMB = (chunk.reduce((sum, att) => {
      try {
        return sum + fs.statSync(att.path).size;
      } catch {
        return sum;
      }
    }, 0) / 1024 / 1024).toFixed(2);
    
    console.log(`✉️ Sending email ${i + 1}/${emailChunks.length} with ${chunk.length} files (${chunkSizeMB}MB)`);

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
      console.log(`✅ Sent email ${i + 1}/${emailChunks.length}`);
      
      // Add delay between emails
      if (i < emailChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_EMAILS));
      }
    } catch (error) {
      console.error(`❌ Failed to send email ${i + 1}:`, error);
      // You might want to break or continue based on your needs
      throw error; // Re-throw to see the actual error
    }
  }

  console.log(`🎉 Completed: ${results.length}/${emailChunks.length} emails sent`);
  
  return {
    emailsSent: results.length,
    totalAttachments: attachments.length,
    chunksCreated: emailChunks.length
  };
};

export default {
  sendEmailWithAttachments
};