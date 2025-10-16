import { healthCheck } from '../lib/functions.js';

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle OPTIONS request for CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        if (req.method === 'GET') {
            const result = healthCheck();
            return res.status(200).json(result);
        } else {
            return res.status(405).json({ 
                success: false,
                error: 'Method not allowed' 
            });
        }
    } catch (error) {
        console.error('Error in health handler:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}