// server.js
import express from 'express';
import path from 'path';
import config, { validateConfig } from './config/index.js';
import { ERROR_MESSAGES } from './config/constants.js';

// Service imports
import * as hubspot from './services/hubspot.js';
import * as analysis from './services/analysis.js';
import * as email from './services/email.js';
import * as utils from './utils/helpers.js';

// Initialize
const app = express();
validateConfig();

// Setup
app.use(express.json({ limit: '10mb' }));

// Helper function to make internal API calls
async function callInternalSendEmail(requestData) {
  try {
    console.log('📤 Calling internal send-email API with data:', requestData);

    const baseUrl = config.NODE_ENV === 'production'
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${config.PORT}`;

    const response = await fetch(`${baseUrl}/api/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData) // Now this is safe
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ Internal send-email API call successful');
    return result;
  } catch (error) {
    console.error('❌ Internal send-email API call failed:', error);
    throw error;
  }
}

// Business Logic
const services = {
  processWebhookData: async (webhookData) => {
    const event = webhookData[0];
    if (!event?.propertyValue) return { shouldReturn204: true, message: "No propertyValue" };

    const { fileId, objectTypeId, recordId } = utils.parseFileRecordString(event.propertyValue);
    const documentUrl = await hubspot.getSignedFileUrl(fileId);
    const fileType = utils.getFileType(documentUrl);

    if (fileType === "unknown") throw new Error(ERROR_MESSAGES.UNSUPPORTED_FILE_TYPE);

    let extractedData;
    try {
      extractedData = fileType === "image"
        ? await analysis.analyzeImage(documentUrl)
        : await analysis.analyzePDF(documentUrl);
    } catch (error) {
      await hubspot.updateErrorLog(objectTypeId, recordId, error.message, { fileType });
      return { shouldReturn204: true, message: "Analysis failed" };
    }

    await hubspot.updateProperty(objectTypeId, recordId, config.HUBSPOT_CONFIG.properties.extractedData, extractedData);
    await hubspot.updateProperty(objectTypeId, recordId, config.HUBSPOT_CONFIG.properties.fileId, fileId);

    // Update individual properties
    await hubspot.updateIndividualProperties(objectTypeId, recordId, extractedData);

    return {
      success: true,
      message: "Document analyzed and HubSpot updated successfully",
      parsedData: { fileId, objectTypeId, recordId },
      fileType
    };
  },

  sendEmailWithAttachments: async (req) => {
    let tempFiles = [];

    try {
      const contactDeal = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.contact,
        req.body.contactId,
        config.HUBSPOT_CONFIG.objectTypes.deal,
        1
      );

      const dealServices = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.deal,
        contactDeal.results[0].toObjectId,
        config.HUBSPOT_CONFIG.objectTypes.service,
        25
      );

      const serviceIds = dealServices.results.map(item => item.toObjectId);

      const serviceDetails = await hubspot.fetchHubSpotBatchRecords(
        config.HUBSPOT_CONFIG.objectTypes.service,
        serviceIds,
        [config.HUBSPOT_CONFIG.properties.fileId],
        false
      );

      // Process files
      const processedFiles = await Promise.all(
        serviceDetails.results.map(async (service) => {
          const fileId = service.properties.file_id;
          if (!fileId) return null;

          try {
            const signedUrl = await hubspot.getSignedFileUrl(fileId);
            const tempPath = await utils.downloadAndSaveFile(signedUrl, fileId);
            tempFiles.push(tempPath);

            return {
              filename: `document_${fileId}${path.extname(new URL(signedUrl).pathname) || '.pdf'}`,
              path: tempPath
            };
          } catch (error) {
            console.error(`File processing failed: ${fileId}`, error);
            return null;
          }
        })
      );

      const attachments = processedFiles.filter(Boolean);
      const emailResult = await email.sendEmailWithAttachments(
        config.EMAIL_CONFIG.sendTo,
        'Document Analysis Report',
        `Please find the attached documents for your review.`,
        attachments
      );

      await utils.cleanupTempFiles(tempFiles);

      return {
        emailSent: true,
        emailsSent: emailResult.emailsSent,
        filesProcessed: attachments.length,
        contactAssociatedDeal: contactDeal,
        dealAssociatedServiceObjects: dealServices,
        dealAssociatedServiceObjectIds: serviceIds,
        dealAssociatedServiceObjectDetails: serviceDetails
      };
    } catch (error) {
      await utils.cleanupTempFiles(tempFiles);
      throw error;
    }
  }
};

// Routes
app.get('/', (req, res) => res.json({
  message: 'Document Analysis API',
  version: '1.0.0',
  environment: config.NODE_ENV
}));

app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;
    if (!Array.isArray(webhookData) || webhookData.length === 0) {
      console.error(ERROR_MESSAGES.INVALID_WEBHOOK);
      return res.status(204).send();
    }

    // Check if this is a deal property change webhook for email sending
    if (webhookData[0].propertyName == config.HUBSPOT_CONFIG.properties.webhookProperty &&
      webhookData[0].subscriptionType == "deal.propertyChange") {

      const dealContact = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.deal,
        webhookData[0].objectId,
        config.HUBSPOT_CONFIG.objectTypes.contact,
        1
      );
      console.log('Deal associated contact:', dealContact);

      if (dealContact.results.length === 0) {
        console.error('No contact associated with the deal.');
        return res.status(204).send();
      }

      const contactId = dealContact?.results[0]?.toObjectId;

      // Send immediate response to HubSpot
      res.status(200).json({
        status: 'success',
        message: 'Email processing initiated via internal API',
        contactId: contactId,
        timestamp: new Date().toISOString()
      });

      // Create a clean data object to pass to the internal API
      const emailRequestData = {
        contactId: contactId,
        toEmail: config.EMAIL_CONFIG.sendTo
        // Add any other data your send-email route needs from the original request
      };

      // Call internal send-email API in background with clean data
      callInternalSendEmail(emailRequestData)
        .then(result => {
          console.log('✅ Internal email processing completed', result);
          hubspot.updateErrorLog("0-3", 46653763141, error.message);
        })
        .catch(error => {
          console.error('❌ Internal email processing failed:', error);
          hubspot.updateErrorLog("0-3", 46653763141, error.message);
        });

      return;
    }

    // Regular webhook processing (this should be fast)
    const result = await services.processWebhookData(webhookData);
    return result.shouldReturn204 ? res.status(204).send() : res.status(200).json(result);

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(204).send();
  }
});

app.post('/api/send-email', async (req, res) => {
  try {
    const result = await services.sendEmailWithAttachments(req);
    res.status(200).json(result);
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({
      error: 'Failed to process and send email',
      details: error.message
    });
  }
});

// Start server
app.listen(config.PORT, () => {
  console.log(`🚀 Server running on http://localhost:${config.PORT}`);
  console.log(`Environment: ${config.NODE_ENV}`);
});

export default app;