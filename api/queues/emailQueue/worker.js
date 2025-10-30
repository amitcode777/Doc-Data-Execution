import { worker } from "@vercel/queues";
import * as email from "../../../../services/email.js";
import * as hubspot from "../../../../services/hubspot.js";
import config from "../../../../config/index.js";

export default worker(async (job) => {
    console.log("Processing queued job:", job.payload);
    const { contactId } = job.payload;
    console.log("📨 Processing queued email job for contact:", contactId);

    try {
        const contactDeal = await hubspot.fetchHubSpotAssociatedData(
            config.HUBSPOT_CONFIG.objectTypes.contact,
            contactId,
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

        const attachments = [];
        for (const service of serviceDetails.results) {
            const fileId = service.properties.file_id;
            if (!fileId) continue;

            const signedUrl = await hubspot.getSignedFileUrl(fileId);
            attachments.push({
                filename: `document_${fileId}.pdf`,
                path: signedUrl
            });
        }

        await email.sendEmailWithAttachments(
            config.EMAIL_CONFIG.sendTo,
            'Document Analysis Report',
            'Please find attached documents.',
            attachments
        );

        console.log("✅ Email sent successfully via queue for contact:", contactId);
        return { success: true, contactId, attachments: attachments.length };

    } catch (error) {
        console.error("❌ Error in email queue worker:", error);
        throw error;
    }
});
