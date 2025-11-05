// email.js
import nodemailer from "nodemailer";
import { MailtrapTransport } from "mailtrap";
import fs from "fs";
import config from "../config/index.js";

const TOKEN = config.EMAIL_CONFIG.apiToken
const TEST_INBOX_ID = config.EMAIL_CONFIG.inboxId

if (!TOKEN) {
  console.error("❌ MAILTRAP_API_TOKEN missing in .env");
  process.exit(1);
}

// Create transporter
const transport = nodemailer.createTransport(
  MailtrapTransport({
    token: TOKEN,
    testInboxId: TEST_INBOX_ID,
    sandbox: true, // enable for testing only
  })
);

const sender = {
  address: config.EMAIL_CONFIG.sendFrom,
  name: "Document Analysis",
};

export const sendEmailWithAttachments = async (to, subject, message, attachments = []) => {
  const MAX_SIZE_PER_EMAIL = 3 * 1024 * 1024; // 5MB
  const DELAY_BETWEEN_EMAILS = 10000;
  console.log(`📧 Preparing to send ${attachments.length} attachments...`);

  const emailChunks = [];
  let currentChunk = [];
  let currentSize = 0;

  // Split attachments into chunks under 5MB
  for (const attachment of attachments) {
    try {
      const fileSize = fs.statSync(attachment.path).size;
      if (fileSize > MAX_SIZE_PER_EMAIL) {
        console.log(`⚠️ Skipping ${attachment.filename} (too large)`);
        continue;
      }
      if (currentSize + fileSize > MAX_SIZE_PER_EMAIL && currentChunk.length > 0) {
        emailChunks.push([...currentChunk]);
        currentChunk = [attachment];
        currentSize = fileSize;
      } else {
        currentChunk.push(attachment);
        currentSize += fileSize;
      }
    } catch (err) {
      console.error(`Error reading file ${attachment.filename}:`, err.message);
    }
  }

  if (currentChunk.length > 0) emailChunks.push(currentChunk);
  console.log(`📨 Total email chunks: ${emailChunks.length}`);

  // Send each chunk one by one
  for (let i = 0; i < emailChunks.length; i++) {
    const chunk = emailChunks[i];
    console.log(`✉️ Sending email ${i + 1}/${emailChunks.length} (${chunk.length} file(s))`);

    const mailOptions = {
      from: sender,
      to,
      subject: emailChunks.length > 1 ? `${subject} (${i + 1}/${emailChunks.length})` : subject,
      text: message,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h3>${subject}</h3>
          <p>${message}</p>
          <small>Files attached: ${chunk.length}</small>
        </div>`,
      attachments: chunk.map((f) => ({ filename: f.filename, path: f.path })),
      category: "Document Processing",
      sandbox: true,
    };

    try {
      const info = await transport.sendMail(mailOptions);
      console.log(`✅ Sent email ${i + 1}:`, info.id || "Success");
    } catch (err) {
      console.error(`❌ Failed to send email ${i + 1}:`, err.message);
    }

    // Always wait before next email — even if it failed
    if (i < emailChunks.length - 1) {
      console.log(`⏳ Waiting ${DELAY_BETWEEN_EMAILS / 1000}s before next email...`);
      await new Promise((res) => setTimeout(res, DELAY_BETWEEN_EMAILS));
    }
  }

  console.log(`🎉 Completed sending ${emailChunks.length} email(s).`);
};