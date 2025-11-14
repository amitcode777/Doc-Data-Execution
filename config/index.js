// config/index.js
import dotenv from 'dotenv';

dotenv.config();

// Environment
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const PORT = process.env.PORT || 3000;

// API Keys
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

// Email Configuration
export const EMAIL_CONFIG = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    sendTo: process.env.EMAIL_SEND_TO,
    // sendUrl: "https://send.api.mailtrap.io/api/send",
    sandboxSendUrl: "https://sandbox.api.mailtrap.io/api/send",
    apiToken: process.env.MAILTRAP_API_TOKEN,
    inboxId: process.env.MAILTRAP_INBOX_ID,
    sendFrom: process.env.EMAIL_FROM
};

// HubSpot Configuration
export const HUBSPOT_CONFIG = {
    urls: {
        association: "https://api.hubapi.com/crm/v4/objects",
        object: "https://api.hubapi.com/crm/v3/objects",
        file: "https://api.hubapi.com/files/v3/files"
    },
    properties: {
        errorLog: "extracted_data_error_log",
        extractedData: "extracted_data",
        fileId: "file_id",
        sendAttachment: "send_attachment",
        webhookProperty: "test_webhook",
    },
    objectTypes: {
        contact: "0-1",
        deal: "0-3",
        ticket: "0-5",
        company: "0-2",
        service: "2-52156116"
    }
};

// OpenAI Configuration
export const OPENAI_CONFIG = {
    model: "gpt-4o-mini",
    maxTokens: 1000,
    analysisPrompt: `Extract structured data from Swiss residence/work permit documents. Output ONLY valid JSON without markdown. Use null for missing fields.`
};

// Validation
export const validateConfig = () => {
    const required = [OPENAI_API_KEY, HUBSPOT_ACCESS_TOKEN];
    if (required.some(field => !field)) {
        throw new Error('❌ Missing required environment variables');
    }
};

export default {
    NODE_ENV,
    PORT,
    OPENAI_API_KEY,
    HUBSPOT_ACCESS_TOKEN,
    EMAIL_CONFIG,
    HUBSPOT_CONFIG,
    OPENAI_CONFIG,
    validateConfig
};