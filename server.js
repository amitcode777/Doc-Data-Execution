// server.js
import express from 'express';
import path from 'path'; // Add this import
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

// Business Logic
const services = {
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
        req.body.toEmail || config.EMAIL_CONFIG.sendTo,
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

    const result = await services.processWebhookData(webhookData);
    result.shouldReturn204 ? res.status(204).send() : res.status(200).json(result);
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(204).send();
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