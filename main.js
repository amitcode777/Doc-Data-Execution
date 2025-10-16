import express from 'express';
import routes from './routes.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api', routes);

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Document Analysis API running on port ${PORT}`);
    console.log(`🔐 Authentication via request body`);
    console.log(`📚 API documentation available at http://localhost:${PORT}/api`);
});