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

import { queueEmailForContact, getQueueStatus, clearQueue } from './services/backgroundEmail.js';

// Initialize
const app = express();
validateConfig();

// Setup
app.use(express.json({ limit: '10mb' }));

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

// server.js - Update webhook route
app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;

    if (webhookData[0].propertyName == config.HUBSPOT_CONFIG.properties.webhookProperty &&
      webhookData[0].subscriptionType == "deal.propertyChange") {
      console.log('🔔 Webhook received for deal property change:', webhookData);


      const dealContact = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.deal,
        webhookData[0].objectId,
        config.HUBSPOT_CONFIG.objectTypes.contact,
        1
      );
      console.log('🔗 Associated contact fetched for deal:', dealContact);

      if (dealContact.results.length > 0) {
        const contactId = dealContact.results[0].toObjectId;
        console.log(`🚀 Queueing background email for contact: ${contactId}`);

        const contactDeal = await hubspot.fetchHubSpotAssociatedData(
          config.HUBSPOT_CONFIG.objectTypes.contact,
          contactId,
          config.HUBSPOT_CONFIG.objectTypes.deal,
          1
        );
        console.log('🔗 Associated deal fetched for contact:', contactDeal);

        if (!contactDeal.results.length) {
          throw new Error(`No deal found for contact: ${contactId}`);
        }

        const dealId = contactDeal.results[0].toObjectId;
        console.log(`📧 Processing deal id: ${dealId}`);

        const dealServices = await hubspot.fetchHubSpotAssociatedData(
          config.HUBSPOT_CONFIG.objectTypes.deal,
          dealId,
          config.HUBSPOT_CONFIG.objectTypes.service,
          25
        );
        console.log('🔗 Associated services fetched for deal:', dealServices);

        const serviceIds = dealServices.results.map(item => item.toObjectId);
        console.log(`🛠️ Service IDs associated with deal:`, serviceIds);

        if (serviceIds.length === 0) {
          throw new Error(`No services found for deal: ${dealId}`);
        }

        const serviceDetails = await hubspot.fetchHubSpotBatchRecords(
          config.HUBSPOT_CONFIG.objectTypes.service,
          serviceIds,
          [config.HUBSPOT_CONFIG.properties.fileId],
          false
        );
        console.log('🗂️ Fetched service details for services:', serviceDetails);
        
        let tempFiles = [];
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

        if (attachments.length === 0) {
          throw new Error('No valid files found to attach');
        }

        // Send email
        const emailResult = await email.sendEmailWithAttachments(
          config.EMAIL_CONFIG.sendTo,
          'Document Analysis Report',
          `Please find the attached documents for your review.`,
          attachments
        );

        await utils.cleanupTempFiles(tempFiles);

        console.log(`✅ Background email completed for contact: ${contactId}`, emailResult);
      }
    } else {
      // Regular processing (fast operations)
      await services.processWebhookData(webhookData);
      return res.status(200).json({
        status: 'success',
        message: 'Webhook received, processing...'
      });
    }

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Add queue monitoring endpoints (optional)
app.get('/queue/status', (req, res) => {
  res.json(getQueueStatus());
});

app.delete('/queue/clear', (req, res) => {
  const cleared = clearQueue();
  res.json({
    message: 'Queue cleared successfully',
    clearedItems: cleared
  });
});

// server.js - Add this endpoint
app.post('/api/background-email', async (req, res) => {
  // This header tells Vercel to run this as a background function
  res.setHeader('x-vercel-background', '1');

  const { contactId, taskId } = req.body;

  console.log(`🚀 Background function started for contact: ${contactId}`);

  try {
    // Immediate response - function continues running in background
    res.status(202).json({
      status: 'accepted',
      message: 'Background processing started',
      taskId,
      contactId
    });

    // Actual processing after response
    let tempFiles = [];
    try {
      console.log(`📧 Processing email for contact: ${contactId}`);

      const contactDeal = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.contact,
        contactId,
        config.HUBSPOT_CONFIG.objectTypes.deal,
        1
      );

      if (!contactDeal.results.length) {
        throw new Error(`No deal found for contact: ${contactId}`);
      }

      const dealId = contactDeal.results[0].toObjectId;

      const dealServices = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.deal,
        dealId,
        config.HUBSPOT_CONFIG.objectTypes.service,
        25
      );

      const serviceIds = dealServices.results.map(item => item.toObjectId);

      if (serviceIds.length === 0) {
        throw new Error(`No services found for deal: ${dealId}`);
      }

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

      if (attachments.length === 0) {
        throw new Error('No valid files found to attach');
      }

      // Send email
      const emailResult = await email.sendEmailWithAttachments(
        config.EMAIL_CONFIG.sendTo,
        'Document Analysis Report',
        `Please find the attached documents for your review.`,
        attachments
      );

      await utils.cleanupTempFiles(tempFiles);

      console.log(`✅ Background email completed for contact: ${contactId}`, emailResult);

    } catch (error) {
      await utils.cleanupTempFiles(tempFiles);
      console.error(`❌ Background email failed for contact: ${contactId}`, error);
    }

  } catch (error) {
    console.error('Background endpoint error:', error);
    res.status(500).json({ error: 'Failed to start background processing' });
  }
});

app.post('/api/send-email', async (req, res) => {
  console.log('📥 /api/send-email called with body:', req.body);
  try {
    const result = await services.sendEmailWithAttachments(req);
    console.log('✅ Email sent successfully with result:', result);
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