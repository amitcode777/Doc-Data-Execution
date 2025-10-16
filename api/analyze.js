import { analyzeDocument } from '../lib/functions.js';

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
        if (req.method === 'POST') {
            const { query, body } = req;
            
            if (!body || Object.keys(body).length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Request body is required'
                });
            }

            const result = await analyzeDocument(body, query);
            return res.status(200).json(result);
        } else {
            return res.status(405).json({ 
                success: false,
                error: 'Method not allowed. Use POST.' 
            });
        }
    } catch (error) {
        console.error('Error in analyze handler:', error);
        
        // Handle different error types with appropriate status codes
        if (error.message.includes('Validation failed') || error.message.includes('Missing')) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        } else if (error.message.includes('Invalid credentials')) {
            return res.status(401).json({
                success: false,
                error: error.message
            });
        } else {
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
}