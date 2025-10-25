import express from 'express';
import dotenv from 'dotenv';
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import nodemailer from 'nodemailer';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));

// Validate required environment variables
const openaiApiKey = process.env.OPENAI_API_KEY;
const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

if (!openaiApiKey || !hubspotToken) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

// Initialize OpenAI client
const client = new OpenAI({ apiKey: openaiApiKey });

// ==================== SIMPLE QUEUE SYSTEM ====================

class SimpleQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.jobs = new Map(); // Store job status
  }

  async add(jobData) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const job = {
      id: jobId,
      data: jobData,
      status: 'queued',
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3
    };

    this.queue.push(job);
    this.jobs.set(jobId, job);
    
    console.log(`📥 Job added to queue: ${jobId}, Queue size: ${this.queue.length}`);
    
    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return jobId;
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    console.log(`🔄 Queue processor started, ${this.queue.length} jobs in queue`);

    while (this.queue.length > 0) {
      const job = this.queue[0]; // Peek at first job
      
      try {
        console.log(`🎯 Processing job: ${job.id}`);
        job.status = 'processing';
        job.startedAt = new Date();
        job.attempts += 1;

        // Process the job
        const result = await processWebhookData(job.data);
        
        job.status = 'completed';
        job.completedAt = new Date();
        job.result = result;

        console.log(`✅ Job completed: ${job.id}`);
        
        // Remove from queue after successful processing
        this.queue.shift();

      } catch (error) {
        console.error(`❌ Job failed: ${job.id}`, error);
        
        if (job.attempts >= job.maxAttempts) {
          job.status = 'failed';
          job.error = error.message;
          job.failedAt = new Date();
          this.queue.shift(); // Remove from queue after max attempts
          console.log(`💀 Job moved to failed state after ${job.attempts} attempts: ${job.id}`);
        } else {
          // Retry logic: move to end of queue
          const failedJob = this.queue.shift();
          this.queue.push(failedJob);
          console.log(`🔄 Job queued for retry (${job.attempts}/${job.maxAttempts}): ${job.id}`);
        }
      }

      // Small delay between jobs to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.processing = false;
    console.log('🏁 Queue processor finished');
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  getQueueStatus() {
    return {
      queued: this.queue.length,
      processing: this.processing ? 1 : 0,
      totalJobs: this.jobs.size,
      completed: Array.from(this.jobs.values()).filter(job => job.status === 'completed').length,
      failed: Array.from(this.jobs.values()).filter(job => job.status === 'failed').length
    };
  }

  // Clean up old completed jobs (optional, to prevent memory leaks)
  cleanupOldJobs(maxAgeHours = 24) {
    const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.completedAt && job.completedAt.getTime() < cutoffTime) {
        this.jobs.delete(jobId);
      }
    }
  }
}

// Initialize the queue
const jobQueue = new SimpleQueue();

// Clean up old jobs every hour
setInterval(() => {
  jobQueue.cleanupOldJobs(1); // Keep jobs for 1 hour
}, 60 * 60 * 1000);

// ==================== HELPER FUNCTIONS ====================

function cleanJSONResponse(responseText) {
  if (!responseText) {
    throw new Error('Empty response from AI model');
  }

  console.log("🔧 Raw AI Response:", responseText);

  // Remove markdown code blocks
  let cleaned = responseText
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // If the response is still not valid JSON, try to extract JSON object
  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
  }

  console.log("🔧 Cleaned JSON:", cleaned);
  return cleaned;
}

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    maxContentLength: 10 * 1024 * 1024,
    timeout: 30000
  });

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
  } catch {
    return "unknown";
  }
}

function generateTempPath(extension = ".tmp") {
  return `/tmp/file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}${extension}`;
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn("Warning: Could not cleanup file:", filePath);
  }
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
    headers: {
      Authorization: `Bearer ${hubspotToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Failed to get signed URL: ${response.status}`);

  const data = await response.json();
  if (!data.url) throw new Error('No URL found in response');

  return data.url;
}

// ==================== ANALYSIS FUNCTIONS ====================

const analysisPrompt = `
You are a document data extraction assistant. Extract structured data from Swiss residence/work permit documents.

CRITICAL INSTRUCTIONS:
- Output ONLY valid JSON without any markdown formatting, code blocks, or additional text
- Do NOT use \`\`\`json or any other markdown
- If a field is missing or unreadable, set its value to null

Required JSON format:
{
  "firstName": "First name from document",
  "lastName": "Last name from document", 
  "streetAddress": "Street + house number + postal code + city",
  "dateOfBirth": "DD.MM.YYYY",
  "nationality": "Nationality",
  "workPermitDate": "Work Permit expiration (DD.MM.YYYY)",
  "workPermitType": "Type of permit"
}

Extraction Rules:
- "Name / Nom / Cognome" → lastName
- "Vorname / Prénom / Nome" → firstName  
- "Geburtsdatum / Date de naissance / Data di nascita" → dateOfBirth
- "Staatsangehörigkeit / Nationalité / Nazionalità" → nationality
- "Kontrollfrist", "Gültig bis", or "Expiration" → workPermitDate
- "Niederlassungsbewilligung", "Aufenthaltsbewilligung", or "Kurzaufenthaltsbewilligung" → workPermitType
`;

async function analyzeImage(url) {
  console.log("🖼️ Analyzing image...");

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: analysisPrompt },
        { type: "image_url", image_url: { url } }
      ],
    }],
    max_tokens: 1000,
    response_format: { type: "json_object" }
  });

  const result = response.choices[0].message.content.trim();
  console.log("📷 Image Analysis Raw Result:", result);

  try {
    const cleanedResult = cleanJSONResponse(result);
    const parsedResult = JSON.parse(cleanedResult);
    console.log("✅ Successfully parsed image analysis JSON");
    return parsedResult;
  } catch (parseError) {
    console.error("❌ Failed to parse JSON response from image analysis:", parseError);
    throw new Error("Invalid JSON response from image analysis");
  }
}

async function analyzePDF(url) {
  console.log("📄 Analyzing PDF...");
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
        role: "user",
        content: [
          { type: "text", text: analysisPrompt },
          { type: "file", file: { file_id: uploadedFile.id } },
        ],
      }],
      max_tokens: 1000,
      response_format: { type: "json_object" }
    });

    const result = response.choices[0].message.content.trim();
    console.log("📚 PDF Analysis Raw Result:", result);

    try {
      const cleanedResult = cleanJSONResponse(result);
      const parsedResult = JSON.parse(cleanedResult);
      console.log("✅ Successfully parsed PDF analysis JSON");
      return parsedResult;
    } catch (parseError) {
      console.error("❌ Failed to parse JSON response from PDF analysis:", parseError);
      throw new Error("Invalid JSON response from PDF analysis");
    }
  } finally {
    cleanupFile(tempPath);
  }
}

// ==================== HUBSPOT FUNCTIONS ====================

async function updateProperty(objectType, objectId, propertyName, propertyValue) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;

  const requestBody = {
    properties: {
      [propertyName]: typeof propertyValue === 'object' ? JSON.stringify(propertyValue) : propertyValue
    }
  };

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${hubspotToken}`,
      "Content-Type": "application/json",
    },
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
    if (propertyValue === null || propertyValue === undefined || propertyValue === '') continue;

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

// ==================== EMAIL FUNCTION ====================

async function sendEmailWithAttachment(to, subject, message, attachmentPath = null) {
  if (!process.env.SMTP_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('Email configuration missing');
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"Document Analysis" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>${subject}</h2>
        <p>${message}</p>
        <p><small>Automated message from Document Analysis System</small></p>
      </div>
    `,
  };

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    mailOptions.attachments = [{
      filename: `document_analysis_${path.basename(attachmentPath)}`,
      path: attachmentPath,
    }];
  }

  const info = await transporter.sendMail(mailOptions);
  console.log("✅ Email sent:", info.messageId);
  return info;
}

// ==================== MAIN PROCESSING FUNCTION ====================

async function processWebhookData(webhookData) {
  try {
    console.log('🔔 Processing webhook data...');

    const event = webhookData[0];
    if (!event) throw new Error('No event data found in webhook');
    if (!event.propertyValue) throw new Error('propertyValue is missing');

    const { fileId, objectTypeId, recordId } = parseFileRecordString(event.propertyValue);
    const documentUrl = await getSignedFileUrl(fileId);
    const fileType = getFileType(documentUrl);

    if (fileType === "unknown") throw new Error("Unsupported file type");

    console.log(`📄 File type: ${fileType}, URL: ${documentUrl}`);

    let extractedData;
    if (fileType === "image") {
      extractedData = await analyzeImage(documentUrl);
    } else if (fileType === "pdf") {
      extractedData = await analyzePDF(documentUrl);
    }

    console.log("📊 Extracted Data:", JSON.stringify(extractedData, null, 2));

    await updateProperty(objectTypeId, recordId, "extracted_data", extractedData);
    const individualUpdates = await updateIndividualProperties(objectTypeId, recordId, extractedData);

    // Send email with attachment
    const signedUrl = await getSignedFileUrl(fileId);
    const extension = fileType === "pdf" ? ".pdf" : ".jpg";
    const tempFilePath = generateTempPath(extension);

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
      message: "Document analyzed and HubSpot updated successfully",
      parsedData: { fileId, objectTypeId, recordId },
      fileType,
      individualUpdates
    };

  } catch (error) {
    console.error("❌ Webhook processing error:", error);
    
    // Send error email
    try {
      await sendEmailWithAttachment(
        process.env.EMAIL_SEND_TO,
        "Document Analysis Failed",
        `The document analysis failed with error: ${error.message}`
      );
    } catch (emailError) {
      console.error("❌ Failed to send error email:", emailError);
    }
    
    throw error;
  }
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  const queueStatus = jobQueue.getQueueStatus();
  res.json({ 
    message: 'Document Analysis API', 
    version: '1.0.0',
    status: 'running',
    queue: queueStatus
  });
});

app.get('/api/health', (req, res) => {
  const queueStatus = jobQueue.getQueueStatus();
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    queue: queueStatus
  });
});

app.get('/api/queue/status', (req, res) => {
  res.json(jobQueue.getQueueStatus());
});

// Webhook endpoint - adds to queue and responds immediately
app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;

    if (!Array.isArray(webhookData) || webhookData.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid webhook data' });
    }

    const event = webhookData[0];
    const jobId = await jobQueue.add(webhookData);

    console.log('📨 Webhook received, added to queue:', jobId);

    // Immediate response to HubSpot
    res.status(202).json({
      success: true,
      message: "Webhook received and queued for processing",
      jobId: jobId,
      status: "queued",
      queuePosition: jobQueue.queue.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error adding job to queue:', error);
    
    // Still respond successfully to HubSpot to avoid retries
    res.status(202).json({
      success: true,
      message: "Webhook received, but queue system had issues",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get job status
app.get('/api/job/:jobId', (req, res) => {
  try {
    const job = jobQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: 'Job not found' 
      });
    }

    const response = {
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts
    };

    if (job.startedAt) response.startedAt = job.startedAt;
    if (job.completedAt) response.completedAt = job.completedAt;
    if (job.failedAt) response.failedAt = job.failedAt;
    if (job.error) response.error = job.error;
    if (job.result) response.result = job.result;

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual job retry
app.post('/api/job/:jobId/retry', async (req, res) => {
  try {
    const job = jobQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'failed') {
      return res.status(400).json({ error: 'Only failed jobs can be retried' });
    }

    // Reset job status and add back to queue
    job.status = 'queued';
    job.attempts = 0;
    job.error = undefined;
    jobQueue.queue.push(job);

    // Start processing if not already running
    if (!jobQueue.processing) {
      jobQueue.processQueue();
    }

    res.json({ success: true, message: 'Job queued for retry' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export for Vercel
export default app;

// Start server for local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📨 Webhook endpoint: http://localhost:${PORT}/webhook/hubspot`);
    console.log(`📊 Queue monitor: http://localhost:${PORT}/api/queue/status`);
  });
}