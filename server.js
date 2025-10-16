import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import API handlers
import indexHandler from './api/index.js';
import analyzeHandler from './api/analyze.js';
import healthHandler from './api/health.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mount API routes
app.get('/api', (req, res) => indexHandler(req, res));
app.post('/api/analyze', (req, res) => analyzeHandler(req, res));
app.get('/api/health', (req, res) => healthHandler(req, res));

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Document Analysis API',
        version: '1.0.0',
        endpoints: {
            'GET /api': 'API information',
            'POST /api/analyze': 'Analyze document and update HubSpot',
            'GET /api/health': 'Health check'
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📚 API available at http://localhost:${PORT}/api`);
});