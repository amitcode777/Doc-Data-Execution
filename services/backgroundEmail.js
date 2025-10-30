// services/backgroundEmail.js
import emailQueue from './queue.js';
import * as hubspot from './hubspot.js';
import * as emailService from './email.js';
import * as utils from '../utils/helpers.js';

export const queueEmailForContact = async (contactId) => {
    const task = async () => {
        console.log(`📧 Starting email processing for contact: ${contactId}`);

        let tempFiles = [];
        try {
            // Fetch HubSpot data
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
            const emailResult = await emailService.sendEmailWithAttachments(
                config.EMAIL_CONFIG.sendTo,
                'Document Analysis Report',
                `Please find the attached documents for your review.`,
                attachments
            );

            await utils.cleanupTempFiles(tempFiles);

            console.log(`✅ Email sent successfully for contact: ${contactId}`, {
                emailsSent: emailResult.emailsSent,
                filesProcessed: attachments.length
            });

            return emailResult;

        } catch (error) {
            // Cleanup temp files even if there's an error
            await utils.cleanupTempFiles(tempFiles);
            console.error(`❌ Email processing failed for contact: ${contactId}`, error);
            throw error; // Re-throw to mark task as failed in queue
        }
    };

    // Add to queue and return task ID
    const taskId = emailQueue.enqueue(task);

    return {
        taskId,
        status: 'queued',
        message: 'Email processing queued successfully',
        contactId,
        queuePosition: emailQueue.getStatus().queued
    };
};

export const getQueueStatus = () => {
    return emailQueue.getStatus();
};

export const clearQueue = () => {
    return emailQueue.clear();
};