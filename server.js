import express from 'express';
import dotenv from 'dotenv';
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const openaiApiKey = process.env.OPENAI_API_KEY;
const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

if (!openaiApiKey || !hubspotToken) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

app.use(express.json({ limit: '10mb' }));
const client = new OpenAI({ apiKey: openaiApiKey });

// Helper Functions
function cleanJSONResponse(responseText) {
  if (!responseText) throw new Error('Empty response from AI model');

  let cleaned = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
  }
  return cleaned;
}

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, response.data);
}

function getFileType(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
    if ([".pdf"].includes(ext)) return "pdf";
    return "unknown";
  } catch { return "unknown"; }
}

function generateTempPath(extension = ".tmp") {
  return `/tmp/file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}${extension}`;
}

function cleanupFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
}

function parseFileRecordString(inputString) {
  const parts = inputString.split(',');
  if (parts.length !== 3) throw new Error('Invalid input format');
  const [fileId, objectTypeId, recordId] = parts.map(part => part.trim());
  if (!fileId || !objectTypeId || !recordId) throw new Error('All parts must be non-empty');
  return { fileId, objectTypeId, recordId };
}

async function getSignedFileUrl(fileId) {
  const response = await fetch(`https://api.hubapi.com/files/v3/files/${fileId}/signed-url`, {
    headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error(`Failed to get signed URL: ${response.status}`);
  const data = await response.json();
  if (!data.url) throw new Error('No URL found in response');
  return data.url;
}

// Analysis Functions
const analysisPrompt = `Extract structured data from Swiss residence/work permit documents. Output ONLY valid JSON without markdown. Use null for missing fields.

Required JSON:
{
  "firstName": "First name from document",
  "lastName": "Last name from document", 
  "streetAddress": "Street + house number + postal code + city",
  "dateOfBirth": "DD.MM.YYYY",
  "nationality": "Nationality",
  "workPermitDate": "Work Permit expiration (DD.MM.YYYY)",
  "workPermitType": "Type of permit"
}`;

async function analyzeImage(url) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user", content: [
        { type: "text", text: analysisPrompt },
        { type: "image_url", image_url: { url } }
      ]
    }],
    max_tokens: 1000,
    response_format: { type: "json_object" }
  });

  const result = response.choices[0].message.content.trim();
  return JSON.parse(cleanJSONResponse(result));
}

async function analyzePDF(url) {
  const tempPath = generateTempPath(".pdf");
  try {
    await downloadFile(url, tempPath);
    const uploadedFile = await client.files.create({
      file: fs.createReadStream(tempPath),
      purpose: "assistants",
    });

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user", content: [
          { type: "text", text: analysisPrompt },
          { type: "file", file: { file_id: uploadedFile.id } },
        ]
      }],
      max_tokens: 1000,
      response_format: { type: "json_object" }
    });

    const result = response.choices[0].message.content.trim();
    return JSON.parse(cleanJSONResponse(result));
  } finally {
    cleanupFile(tempPath);
  }
}

// HubSpot Functions
async function updateProperty(objectType, objectId, propertyName, propertyValue) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;
  const requestBody = {
    properties: { [propertyName]: typeof propertyValue === 'object' ? JSON.stringify(propertyValue) : propertyValue }
  };

  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${hubspotToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) throw new Error(`HubSpot update failed: ${response.status}`);
  return await response.json();
}

async function updateIndividualProperties(objectTypeId, recordId, extractedData) {
  const fullName = [extractedData.firstName, extractedData.lastName].filter(Boolean).join(' ');
  const propertiesToUpdate = {
    'extracted_full_name': fullName,
    'extracted_address': extractedData.streetAddress,
    'extracted_dob': extractedData.dateOfBirth,
    'extracted_nationality': extractedData.nationality,
    'extracted_work_permit_date': extractedData.workPermitDate,
    'extracted_work_permit_type': extractedData.workPermitType
  };

  const updates = [];
  for (const [propertyName, propertyValue] of Object.entries(propertiesToUpdate)) {
    if (!propertyValue) continue;
    try {
      await updateProperty(objectTypeId, recordId, propertyName, propertyValue);
      updates.push({ property: propertyName, success: true });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      updates.push({ property: propertyName, success: false, error: error.message });
    }
  }
  return updates;
}

async function getHubSpotRecord(objectType, objectId, queryParams = '') {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}?properties=${queryParams}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
  return await response.json();
}

function getObjectTypeBySubscription(subscriptionType) {
  const subscriptionMap = {
    "contact.propertyChange": "0-1",
    "company.propertyChange": "0-2",
    "deal.propertyChange": "0-3",
    "ticket.propertyChange": "0-5"
  };

  // If it's a standard type, return from map
  if (subscriptionMap[subscriptionType]) {
    return subscriptionMap[subscriptionType];
  }

  // If it's a custom object (ends with .propertyChange)
  if (subscriptionType.endsWith('.propertyChange')) {
    const objectName = subscriptionType.replace('.propertyChange', '');
    return `p_${objectName}`;
  }
}

// Email Function
async function sendEmailWithAttachment(to, subject, message, attachmentPath = null) {
  if (!process.env.SMTP_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('Email configuration missing');
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const mailOptions = {
    from: `"Document Analysis" <${process.env.EMAIL_USER}>`,
    to, subject,
    html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>${subject}</h2><p>${message}</p>
      <p><small>Automated message from Document Analysis System</small></p>
    </div>`,
  };

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    mailOptions.attachments = [{
      filename: `document_analysis_${path.basename(attachmentPath)}`,
      path: attachmentPath,
    }];
  }

  return await transporter.sendMail(mailOptions);
}

// Main Processing
async function processWebhookData(webhookData) {
  const event = webhookData[0];
  if (!event?.propertyValue) {
    return { success: false, message: "No propertyValue in webhook data" };
  }

  if (event.propertyName === "file_id") {
    const objectRecordId = event.objectId;
    let objectType = getObjectTypeBySubscription(event.subscriptionType);
    const objectDetails = await getHubSpotRecord(objectType, objectRecordId, "file_id");
    if (!objectDetails?.properties?.file_id) {
      return {
        success: false,
        message: "No file_id found on the record",
        parsedData: { objectType, objectRecordId },
      };
    }
    const fileId = objectDetails.properties.file_id;
    const signedUrl = await getSignedFileUrl(fileId);
    const fileType = getFileType(signedUrl);
    const tempFilePath = generateTempPath(fileType === "pdf" ? ".pdf" : ".jpg");

    await downloadFile(signedUrl, tempFilePath);
    await sendEmailWithAttachment(
      process.env.EMAIL_SEND_TO,
      "Document Analysis Completed",
      `The ${fileType} document has been successfully analyzed.`,
      tempFilePath
    );
    cleanupFile(tempFilePath);

    return {
      success: true,
      message: "Email sent successfully",
      parsedData: { fileId, objectDetails, objectRecordId },
      fileType,
    };
  }

  const { fileId, objectTypeId, recordId } = parseFileRecordString(event.propertyValue);
  const documentUrl = await getSignedFileUrl(fileId);
  const fileType = getFileType(documentUrl);
  if (fileType === "unknown") throw new Error("Unsupported file type");

  const extractedData = fileType === "image" ? await analyzeImage(documentUrl) : await analyzePDF(documentUrl);

  await updateProperty(objectTypeId, recordId, "extracted_data", extractedData);
  await updateProperty(objectTypeId, recordId, "file_id", fileId);
  const individualUpdates = await updateIndividualProperties(objectTypeId, recordId, extractedData);

  return {
    success: true,
    message: "Document analyzed and HubSpot updated successfully",
    parsedData: { fileId, objectTypeId, recordId },
    fileType,
    individualUpdates
  };
}

// Routes
app.get('/', (req, res) => res.json({ message: 'Document Analysis API', version: '1.0.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;
    if (!Array.isArray(webhookData) || webhookData.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid webhook data' });
    }
    const result = await processWebhookData(webhookData);
    res.status(200).json(result);
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}