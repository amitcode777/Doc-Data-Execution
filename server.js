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

// Helper function for internal API calls
const callInternalAPI = async (endpoint, data) => {
  const baseUrl = process.env.URL
    ? `${process.env.URL}`
    : `http://localhost:${config.PORT}`;

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || `API call failed: ${endpoint}`);
  }

  return await response.json();
};

// Business Logic
const services = {

  processWebhookData: async (webhookData) => {
    const event = webhookData[0];
    if (!event?.propertyValue) return { shouldReturn204: true, message: "No propertyValue" };

    const { fileId, objectTypeId, recordId } = utils.parseFileRecordString(event.propertyValue);
    const documentUrl = await hubspot.getSignedFileUrl(fileId);
    console.log(`🔗 Fetched signed URL for fileId: ${documentUrl}`);
    const fileType = utils.getFileType(documentUrl);
    console.log(`📄 Detected file type: ${fileType}`);

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

    console.log(`🧾 Extracted data:`, extractedData);
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

// API 1: Fetch Service Details (calls process-files API)
const fetchContactServiceDetails = async (contactId) => {
  try {
    console.log(`🔍 Starting service details fetch for contact: ${contactId}`);

    // Fetch associated deal for contact
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
    console.log(`📧 Processing deal id: ${dealId}`);

    // Fetch services associated with deal
    const dealServices = await hubspot.fetchHubSpotAssociatedData(
      config.HUBSPOT_CONFIG.objectTypes.deal,
      dealId,
      config.HUBSPOT_CONFIG.objectTypes.service,
      25
    );

    const serviceIds = dealServices.results.map(item => item.toObjectId);
    console.log(`🛠️ Service IDs associated with deal:`, serviceIds);

    if (serviceIds.length === 0) {
      throw new Error(`No services found for deal: ${dealId}`);
    }

    // Fetch service details with file_id property
    const serviceDetails = await hubspot.fetchHubSpotBatchRecords(
      config.HUBSPOT_CONFIG.objectTypes.service,
      serviceIds,
      [config.HUBSPOT_CONFIG.properties.fileId],
      false
    );

    console.log('🗂️ Fetched service details for services:', serviceDetails.results.length);

    // Call process-files API which will internally call send-email API
    const fileProcessing = await callInternalAPI('/api/services/process-files', {
      serviceDetails: serviceDetails.results,
      contactId: contactId,
      dealId: dealId
    });

    return {
      success: true,
      contactId,
      dealId,
      serviceDetails: serviceDetails.results,
      fileProcessing: fileProcessing,
      totalServices: serviceIds.length,
      metadata: {
        contactDeal: contactDeal.results[0],
        dealServices: dealServices.results
      }
    };

  } catch (error) {
    console.error('Error in fetchContactServiceDetails:', error);
    return {
      success: false,
      error: error.message,
      contactId
    };
  }
};

// API 2: Process Files (calls send-email API)
const processServiceFiles = async (serviceDetails, contactId = null, dealId = null) => {
  const tempFiles = [];
  const processedResults = [];

  try {
    console.log(`📁 Processing files for ${serviceDetails.length} services`);

    // Process all files in parallel
    const processingPromises = serviceDetails.map(async (service) => {
      const fileId = service.properties.file_id;
      if (!fileId) {
        processedResults.push({
          success: false,
          serviceId: service.id,
          error: 'No file_id found'
        });
        return null;
      }

      try {
        // Get signed URL and download file
        const signedUrl = await hubspot.getSignedFileUrl(fileId);
        const tempPath = await utils.downloadAndSaveFile(signedUrl, fileId);

        // Extract file extension from URL or default to PDF
        const fileExtension = path.extname(new URL(signedUrl).pathname) || '.pdf';

        const fileInfo = {
          filename: `document_${fileId}${fileExtension}`,
          path: tempPath,
          fileId: fileId,
          serviceId: service.id
        };

        tempFiles.push(tempPath);
        processedResults.push({
          success: true,
          fileInfo: fileInfo,
          serviceId: service.id
        });

        return fileInfo;

      } catch (error) {
        console.error(`File processing failed for fileId: ${fileId}`, error);
        processedResults.push({
          success: false,
          serviceId: service.id,
          fileId: fileId,
          error: error.message
        });
        return null;
      }
    });

    const attachments = (await Promise.all(processingPromises)).filter(Boolean);

    if (attachments.length === 0) {
      throw new Error('No valid files were successfully processed');
    }

    console.log(`✅ Successfully processed ${attachments.length} files`);

    // Call send-email API
    const emailResult = await callInternalAPI('/api/services/send-email', {
      attachments: attachments,
      tempFiles: tempFiles,
      contactId: contactId,
      dealId: dealId
    });

    return {
      success: true,
      attachments: attachments,
      tempFiles: tempFiles,
      emailResult: emailResult,
      processingSummary: {
        totalProcessed: serviceDetails.length,
        successful: attachments.length,
        failed: processedResults.filter(r => !r.success).length,
        detailedResults: processedResults
      }
    };

  } catch (error) {
    console.error('Error in processServiceFiles:', error);

    // Cleanup temp files if processing fails
    if (tempFiles.length > 0) {
      await utils.cleanupTempFiles(tempFiles).catch(cleanupError => {
        console.error('Error during cleanup in processServiceFiles:', cleanupError);
      });
    }

    return {
      success: false,
      error: error.message,
      tempFiles: [], // Already cleaned up
      processingSummary: {
        totalProcessed: serviceDetails.length,
        successful: 0,
        failed: serviceDetails.length,
        detailedResults: processedResults
      }
    };
  }
};

// API 3: Send Email with Attachments
const sendServiceDocumentsEmail = async (attachments, tempFiles, contactId = null, dealId = null) => {
  let emailResult = null;
  let cleanupSuccess = false;

  try {
    console.log(`📧 Preparing to send email with ${attachments?.length || 0} attachments`);

    // Validate inputs
    if (!attachments || attachments.length === 0) {
      throw new Error('No attachments provided');
    }

    if (!tempFiles || tempFiles.length === 0) {
      throw new Error('No temp files provided for cleanup');
    }

    // Send email with attachments
    emailResult = await email.sendEmailWithAttachments(
      config.EMAIL_CONFIG.sendTo,
      'Document Analysis Report',
      `Please find the attached documents for your review. Total documents: ${attachments.length}`,
      attachments
    );

    console.log('✅ Email sent successfully, cleaning up temporary files');

    // Cleanup temporary files after successful email send
    cleanupSuccess = utils.cleanupTempFiles(tempFiles);

    console.log('✅ Temporary files cleaned up successfully');

    return {
      success: true,
      emailResult: emailResult,
      // cleanupSuccess: cleanupSuccess,
      summary: {
        attachmentsSent: attachments.length,
        tempFilesCleaned: tempFiles.length,
        recipient: config.EMAIL_CONFIG.sendTo,
        contactId,
        dealId
      }
    };

  } catch (error) {
    console.error('Error in sendServiceDocumentsEmail:', error);

    // Attempt cleanup even if email fails
    try {
      if (tempFiles && tempFiles.length > 0) {
        console.log('🔄 Attempting emergency cleanup of temporary files');
        await utils.cleanupTempFiles(tempFiles);
        cleanupSuccess = true;
        console.log('✅ Emergency cleanup completed');
      }
    } catch (cleanupError) {
      console.error('❌ Error during emergency cleanup:', cleanupError);
    }

    return {
      success: false,
      error: error.message,
      emailResult: emailResult,
      cleanupSuccess: cleanupSuccess,
      attachmentsAttempted: attachments ? attachments.length : 0
    };
  }
};

// Routes
app.get('/', (req, res) => res.json({
  message: 'Document Analysis API',
  version: '1.0.0',
  environment: config.NODE_ENV
}));

// Webhook Route (calls only fetch-service-details API)
app.post('/webhook/hubspot', async (req, res) => {
  try {
    const webhookData = req.body;

    if (webhookData[0].propertyName == config.HUBSPOT_CONFIG.properties.webhookProperty &&
      webhookData[0].subscriptionType == "deal.propertyChange") {
      console.log('🔔 Webhook received for deal property change:', webhookData);

      res.status(200).json({
        status: 'success',
        message: 'Webhook received, background process completed',
      })

      const dealContact = await hubspot.fetchHubSpotAssociatedData(
        config.HUBSPOT_CONFIG.objectTypes.deal,
        webhookData[0].objectId,
        config.HUBSPOT_CONFIG.objectTypes.contact,
        1
      );
      console.log('🔗 Associated contact fetched for deal:', dealContact);

      if (dealContact.results.length > 0) {
        const contactId = dealContact.results[0].toObjectId;
        console.log(`🚀 Starting background process for contact: ${contactId}`);

        // Call only the fetch-service-details API (which will call the others)
        await callInternalAPI('/api/services/fetch-service-details', {
          contactId
        });

        console.log(`✅ Background process completed for contact: ${contactId}`);

        return;
      }
    } else {
      // Regular processing (fast operations)
      res.status(200).json({
        status: 'success',
        message: 'Webhook received, completed...'
      });
      await services.processWebhookData(webhookData);
      return;
    }

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed: ' + error.message });
  }
});

// API Route 1: Fetch Service Details (calls process-files API)
app.post('/api/services/fetch-service-details', async (req, res) => {
  try {
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({ error: 'contactId is required' });
    }

    const result = await fetchContactServiceDetails(contactId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(404).json(result);
    }

  } catch (error) {
    console.error('Error in /api/services/fetch-service-details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Route 2: Process Files (calls send-email API)
app.post('/api/services/process-files', async (req, res) => {
  try {
    const { serviceDetails, contactId, dealId } = req.body;

    if (!serviceDetails || !Array.isArray(serviceDetails)) {
      return res.status(400).json({ error: 'serviceDetails array is required' });
    }

    const result = await processServiceFiles(serviceDetails, contactId, dealId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Error in /api/services/process-files:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API Route 3: Send Email
app.post('/api/services/send-email', async (req, res) => {
  try {
    const { attachments, tempFiles, contactId, dealId } = req.body;

    if (!attachments || !Array.isArray(attachments)) {
      return res.status(400).json({ error: 'attachments array is required' });
    }

    if (!tempFiles || !Array.isArray(tempFiles)) {
      return res.status(400).json({ error: 'tempFiles array is required' });
    }

    const result = await sendServiceDocumentsEmail(attachments, tempFiles, contactId, dealId);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Error in /api/services/send-email:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Existing email route (keep for backward compatibility)
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