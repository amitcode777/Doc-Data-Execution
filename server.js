import express from 'express';
import dotenv from 'dotenv';
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import nodemailer from 'nodemailer';

dotenv.config();

// Configuration and secrets
const app = express();
const PORT = process.env.PORT || 3000;
const openaiApiKey = process.env.OPENAI_API_KEY;
const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
const smtpHost = process.env.SMTP_HOST;
const emailSendTo = process.env.EMAIL_SEND_TO;
const smtpPort = process.env.SMTP_PORT || 587;
const emailSecure = process.env.SMTP_SECURE === "true";
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;

// Hubspot property names
const extractedDataErrorLogProperty = "extracted_data_error_log";
const extractedDataProperty = "extracted_data";
const fileIdProperty = "file_id";

if (!openaiApiKey || !hubspotToken) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

app.use(express.json({ limit: '10mb' }));
const client = new OpenAI({ apiKey: openaiApiKey });

// Helper Functions
function cleanJSONResponse(responseText) {
  try {
    if (!responseText) throw new Error('Empty response from AI model');

    let cleaned = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];
    }
    return cleaned;
  } catch (error) {
    console.error('Error cleaning JSON response:', error);
    throw error;
  }
}

async function downloadFile(url, outputPath) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, response.data);
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`File download failed: ${error.message}`);
  }
}

function getFileType(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
    if ([".pdf"].includes(ext)) return "pdf";
    return "unknown";
  } catch (error) {
    console.error('Error getting file type:', error);
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
    console.error('Error cleaning up file:', error);
  }
}

function parseFileRecordString(inputString) {
  try {
    const parts = inputString.split(',');
    if (parts.length !== 3) throw new Error('Invalid input format');
    const [fileId, objectTypeId, recordId] = parts.map(part => part.trim());
    if (!fileId || !objectTypeId || !recordId) throw new Error('All parts must be non-empty');
    return { fileId, objectTypeId, recordId };
  } catch (error) {
    console.error('Error parsing file record string:', error);
    throw new Error(`Invalid file record format: ${error.message}`);
  }
}

async function getSignedFileUrl(fileId) {
  try {
    const response = await fetch(`https://api.hubapi.com/files/v3/files/${fileId}/signed-url`, {
      headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`Failed to get signed URL: ${response.status}`);
    const data = await response.json();
    if (!data.url) throw new Error('No URL found in response');
    return data.url;
  } catch (error) {
    console.error('Error getting signed file URL:', error);
    throw new Error(`Failed to get file URL: ${error.message}`);
  }
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
  try {
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
  } catch (error) {
    console.error('OpenAI API error in analyzeImage:', error);
    throw new Error(`OpenAI image analysis failed: ${error.message}`);
  }
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
          { type: "file", file: { file_id: uploadedFile?.id } },
        ]
      }],
      max_tokens: 1000,
      response_format: { type: "json_object" }
    });

    const result = response?.choices[0]?.message?.content.trim();
    return JSON.parse(cleanJSONResponse(result));
  } catch (error) {
    console.error('OpenAI API error in analyzePDF:', error);
    throw new Error(`OpenAI PDF analysis failed: ${error.message}`);
  } finally {
    cleanupFile(tempPath);
  }
}

// HubSpot Functions
async function updateProperty(objectType, objectId, propertyName, propertyValue) {
  try {
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
  } catch (error) {
    console.error('Error updating HubSpot property:', error);
    throw new Error(`Failed to update property: ${error.message}`);
  }
}

async function updateErrorLog(objectTypeId, recordId, errorMessage, additionalData = {}) {
  try {
    const errorData = {
      error: true,
      errorMessage: errorMessage,
      timestamp: new Date().toISOString(),
      ...additionalData
    };

    await updateProperty(objectTypeId, recordId, extractedDataErrorLogProperty, errorData);
    console.log('Error log updated successfully in HubSpot');
  } catch (updateError) {
    console.error('Failed to update error log in HubSpot:', updateError);
  }
}

async function updateIndividualProperties(objectTypeId, recordId, extractedData) {
  try {
    const fullName = [extractedData?.firstName, extractedData?.lastName].filter(Boolean).join(' ');
    const propertiesToUpdate = {
      'extracted_full_name': fullName,
      'extracted_address': extractedData?.streetAddress,
      'extracted_dob': extractedData?.dateOfBirth,
      'extracted_nationality': extractedData?.nationality,
      'extracted_work_permit_date': extractedData?.workPermitDate,
      'extracted_work_permit_type': extractedData?.workPermitType
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
  } catch (error) {
    console.error('Error updating individual properties:', error);
    throw error;
  }
}

async function getHubSpotRecord(objectType, objectId, queryParams = '') {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}?properties=${queryParams}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error getting HubSpot record:', error);
    throw new Error(`Failed to get HubSpot record: ${error.message}`);
  }
}

function getObjectTypeBySubscription(subscriptionType) {
  try {
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

    throw new Error(`Unknown subscription type: ${subscriptionType}`);
  } catch (error) {
    console.error('Error getting object type by subscription:', error);
    throw error;
  }
}

// Email Function
async function sendEmailWithAttachment(to, subject, message, attachmentPath = null) {
  try {
    if (!smtpHost || !emailUser || !emailPass) {
      throw new Error('Email configuration missing');
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: emailSecure,
      auth: { user: emailUser, pass: emailPass },
    });

    const mailOptions = {
      from: `"Document Analysis" <${emailUser}>`,
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
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

// Main Processing
async function processWebhookData(webhookData) {
  let objectTypeId, recordId;
  console.log('Processing webhook data:', JSON.stringify(webhookData, null, 2));
  try {
    const event = webhookData[0];
    if (!event?.propertyValue) {
      return {
        success: false,
        status_code: 204,
        message: "No propertyValue in webhook data"
      };
    }

    if (event?.propertyName === fileIdProperty) {
      recordId = event?.objectId;
      objectTypeId = getObjectTypeBySubscription(event?.subscriptionType);
      try {
        console.log(`Fetching HubSpot record for objectTypeId: ${objectTypeId}, recordId: ${recordId}`);
        const objectDetails = await getHubSpotRecord(objectTypeId, recordId, fileIdProperty);

        if (!objectDetails?.properties?.file_id) {
          return {
            success: false,
            status_code: 204,
            message: "No file_id found on the record"
          };
        }

        const fileId = objectDetails?.properties?.file_id;
        const signedUrl = await getSignedFileUrl(fileId);
        const fileType = getFileType(signedUrl);
        const tempFilePath = generateTempPath(fileType === "pdf" ? ".pdf" : ".jpg");

        await downloadFile(signedUrl, tempFilePath);
        await sendEmailWithAttachment(
          emailSendTo,
          "Document Analysis Completed",
          `The ${fileType} document has been successfully analyzed.`,
          tempFilePath
        );

        await updateProperty(objectTypeId, recordId, extractedDataErrorLogProperty, "");
        cleanupFile(tempFilePath);

        return {
          success: true,
          message: "Email sent successfully",
          parsedData: { fileId, objectDetails, recordId },
          fileType,
        };
      } catch (error) {
        // If we have objectTypeIdId and recordId, update error log
        if (objectTypeId && recordId) {
          await updateErrorLog(objectTypeId, recordId, error.message);
        } else {
          console.error('Cannot update error log - missing objectTypeId or recordId');
        }
        return {
          shouldReturn204: true,
          message: "Processing failed, error recorded in error log property"
        };
      }
    }

    // Parse file record and get object info for error logging
    const { fileId, objectTypeId: parsedObjectTypeId, recordId: parsedRecordId } = parseFileRecordString(event?.propertyValue);
    objectTypeId = parsedObjectTypeId;
    recordId = parsedRecordId;
    console.log(`Parsed fileId: ${fileId}, objectTypeId: ${objectTypeId}, recordId: ${recordId}`);

    const documentUrl = await getSignedFileUrl(fileId);
    const fileType = getFileType(documentUrl);

    if (fileType === "unknown") {
      throw new Error("Unsupported file type");
    }

    let extractedData;
    try {
      // Try to analyze the document with OpenAI
      extractedData = fileType === "image" ? await analyzeImage(documentUrl) : await analyzePDF(documentUrl);
    } catch (openaiError) {
      // If OpenAI fails, update the error log property
      await updateErrorLog(objectTypeId, recordId, openaiError.message, { fileType });
      return {
        shouldReturn204: true,
        message: "OpenAI analysis failed, error recorded in error log property"
      };
    }

    // If OpenAI analysis was successful, proceed with normal flow
    await updateProperty(objectTypeId, recordId, extractedDataProperty, extractedData);
    await updateProperty(objectTypeId, recordId, fileIdProperty, fileId);

    // For clear contact error log property values
    const objectType = getObjectTypeBySubscription(event?.subscriptionType);
    const objectRecordId = event?.objectId;
    await updateProperty(objectType, objectRecordId, extractedDataErrorLogProperty, "");
    
    // Update individual properties
    const individualUpdates = await updateIndividualProperties(objectTypeId, recordId, extractedData);

    return {
      success: true,
      message: "Document analyzed and HubSpot updated successfully",
      parsedData: { fileId, objectTypeId, recordId },
      fileType,
      individualUpdates
    };

  } catch (error) {
    console.error('Error in processWebhookData:', error);

    // If we have objectTypeId and recordId, update error log
    if (objectTypeId && recordId) {
      objectTypeId = getObjectTypeBySubscription(webhookData[0]?.subscriptionType);
      recordId = webhookData[0]?.objectId;
      await updateErrorLog(objectTypeId, recordId, error.message);
    } else {
      console.error('Cannot update error log - missing objectTypeId or recordId');
    }

    return {
      shouldReturn204: true,
      message: "Processing failed, error recorded in error log property"
    };
  }
}

// Routes
app.get('/', (req, res) => res.json({ message: 'Document Analysis API', version: '1.0.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;
    if (!Array.isArray(webhookData) || webhookData.length === 0) {
      // Even for invalid data, return 204 and don't throw error
      console.error('Invalid webhook data received');
      return res.status(204).send();
    }

    const result = await processWebhookData(webhookData);

    // Check if we should return 204 for any error
    if (result.shouldReturn204) {
      return res.status(204).send();
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Unexpected error in webhook handler:', error);
    // Always return 204 even for unexpected errors
    return res.status(204).send();
  }
});

export default app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}