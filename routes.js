import express from 'express';
import { 
    analyzeDocument, 
    healthCheck, 
    getApiInfo 
} from './functions.js';

const router = express.Router();

// API information
router.get('/', getApiInfo);

// Health check
router.get('/health', healthCheck);

// Analyze document
router.post('/analyze', analyzeDocument);

export default router;