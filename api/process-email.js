// api/process-email.js
import { hubspot, email } from '../services/index.js';
import config from '../config/index.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { contactId } = req.body;
        console.log('🔄 Processing email for contact:', contactId);

        const result = await email.sendEmailWithAttachments({
            body: {
                contactId: contactId,
                toEmail: config.EMAIL_CONFIG.sendTo
            }
        });

        console.log('✅ Email processing completed:', result);
        res.status(200).json(result);
    } catch (error) {
        console.error('❌ Email processing failed:', error);
        res.status(500).json({ error: error.message });
    }
}