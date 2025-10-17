import express from 'express';
import dotenv from 'dotenv';
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configuration
const config = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN,
    auth: {
        username: process.env.API_USERNAME || "admin",
        password: process.env.API_PASSWORD || "password123"
    }
};

// Initialize OpenAI client
const client = new OpenAI({
    apiKey: config.openaiApiKey,
});

// ==================== WoodsPortal ID Extraction Function ====================
function extractWoodsPortalId(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: 'Invalid file path provided' };
    }

    // Pattern: /WoodsPortal/{number}/{anything}/{numeric_id}/{filename}
    const pattern = /\/WoodsPortal\/(\d+)\/([\d-]+)\/(\d+)\/([^\/]+)$/;
    const match = filePath.match(pattern);

    if (match) {
        return {
            success: true,
            portalId: match[1],      // "745" from first example
            sectionId: match[2],     // "0-1" from first example
            extractedId: match[3],   // "164064040211" - the main ID we want
            fileName: match[4],      // "Screenshot 2025-10-14 at 12.55.13 PM.png"
            fullPath: filePath
        };
    }

    return { success: false, error: 'WoodsPortal pattern not found in path' };
}

// ==================== ROUTES ====================

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Document Analysis API',
        version: '1.0.0',
        endpoints: {
            'POST /api/analyze': 'Analyze document and update HubSpot',
            'GET /api/health': 'Health check',
            'GET /api/extract-id': 'Extract ID from WoodsPortal path'
        }
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Document Analysis API",
        environment: process.env.NODE_ENV || "development"
    });
});

// ==================== NEW ROUTE: Extract ID from WoodsPortal Path ====================
app.get('/api/extract-id', (req, res) => {
    try {
        const { path: filePath } = req.query;

        if (!filePath) {
            return res.status(400).json({
                success: false,
                error: 'Missing required query parameter: path'
            });
        }

        console.log(`🔍 Extracting ID from path: ${filePath}`);

        const result = extractWoodsPortalId(filePath);

        if (result.success) {
            res.json({
                success: true,
                extractedId: result.extractedId,

                portalId: result.portalId,
                sectionId: result.sectionId,
                fileName: result.fileName,
                fullPath: result.fullPath

            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                providedPath: filePath
            });
        }

    } catch (error) {
        console.error('❌ Error in extract-id endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== Existing Analyze Document Route ====================
// (Keep all your existing helper functions: downloadFile, getFileType, analyzeImage, analyzePDF, updateProperty, etc.)

// Helper: download file temporarily
async function downloadFile(url, outputPath) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        maxContentLength: 10 * 1024 * 1024
    });

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, response.data);
}

// Detect file type from URL
function getFileType(url) {
    try {
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
        if ([".pdf"].includes(ext)) return "pdf";
        return "unknown";
    } catch (error) {
        return "unknown";
    }
}

// Generate temporary file path
function generateTempPath(extension = ".tmp") {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `/tmp/file_${timestamp}_${random}${extension}`;
}

// Cleanup temporary file
function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn("Warning: Could not cleanup temporary file:", filePath);
    }
}

// Analyze Image
async function analyzeImage(url) {
    console.log("🖼️ Analyzing image from URL...");

    const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Read and extract only the exact visible text from this image. Respond only with the text content exactly as it appears.",
                    },
                    { type: "image_url", image_url: { url } },
                ],
            },
        ],
    });

    const result = response.choices[0].message.content.trim();
    console.log("> 📝 Extracted Text Length:", result.length);
    return result;
}

// Analyze PDF
async function analyzePDF(url) {
    console.log("📄 Downloading and analyzing PDF...");

    const tempPath = generateTempPath(".pdf");

    try {
        // 1️⃣ Download the PDF locally
        await downloadFile(url, tempPath);

        // 2️⃣ Upload to OpenAI
        const uploadedFile = await client.files.create({
            file: fs.createReadStream(tempPath),
            purpose: "assistants",
        });

        // 3️⃣ Use structured extraction prompt
        const prompt = `
                    You are a PDF data extraction assistant designed for automation workflows.
                    Your job is to extract structured data from a Swiss residence or work permit (PDF text).

                    Output ONLY valid JSON.
                    Do NOT include explanations, markdown, or extra text.
                    If a field is missing or unreadable, set its value to null.

                    Required JSON format:
                    {
                    "firstName": "First name of the person from the PDF",
                    "lastName": "Last name of the person from the PDF",
                    "streetAddress": "Street name + house number + postal code + city",
                    "dateOfBirth": "DD.MM.YYYY",
                    "nationality": "Nationality from the document",
                    "workPermitDate": "Work Permit expiration or Kontrollfrist date (DD.MM.YYYY)",
                    "workPermitType": "Type of permit, e.g., Niederlassungsbewilligung, Aufenthaltsbewilligung, Kurzaufenthaltsbewilligung"
                    }

                    Extraction Rules:
                    - “Name / Nom / Cognome” → lastName
                    - “Vorname / Prénom / Nome” → firstName
                    - “Geburtsdatum / Date de naissance / Data di nascita” → dateOfBirth
                    - “Staatsangehörigkeit / Nationalité / Nazionalità” → nationality
                    - “Kontrollfrist”, “Gültig bis”, or “Expiration” → workPermitDate
                    - “Niederlassungsbewilligung”, “Aufenthaltsbewilligung”, or “Kurzaufenthaltsbewilligung” → workPermitType
                    - Address is usually near “Strasse / Rue / Via” and may contain a postal code (e.g., 5103 Wildegg).
                    `;

        // 4️⃣ Send to GPT model
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini", // or "gpt-4o" for more reliable output
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "file", file: { file_id: uploadedFile.id } },
                    ],
                },
            ],
        });

        // 5️⃣ Parse and validate response
        const result = response.choices[0].message.content.trim();
        console.log("📚 PDF Analysis Result:", result);

        try {
            const parsedResult = JSON.parse(result);
            console.log("✅ Successfully parsed JSON");
            return parsedResult;
        } catch (parseError) {
            console.error("❌ Failed to parse JSON response:", parseError);
            console.log("Raw response:", result);
            throw new Error("Invalid JSON response from AI");
        }

    } catch (error) {
        console.error("❌ Error analyzing PDF:", error);
        throw error;
    } finally {
        cleanupFile(tempPath);
    }
}


// Update HubSpot property
async function updateProperty(objectType, objectId, propertyValue) {
    const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;

    const response = await fetch(url, {
        method: "PATCH",
        headers: {
            "Authorization": `Bearer ${config.hubspotToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            properties: {
                "test_property": JSON.stringify(propertyValue) // 👈 Must be a multiline text property in HubSpot
            },
        }),
    });

    // 🧩 Handle errors properly
    if (!response.ok) {
        const errorData = await response.json();
        console.error("❌ Failed to update property:", errorData);
        throw new Error(`HubSpot update failed: ${response.status}`);
    }

    const data = await response.json();
    console.log("✅ Successfully updated HubSpot property");
    return data;
}




// Authentication middleware
function authenticate(body) {
    const { username, password } = body;

    if (!username || !password) {
        throw new Error("Missing username or password in request body");
    }

    if (username !== config.auth.username || password !== config.auth.password) {
        throw new Error("Invalid credentials");
    }
}

// Validation
function validateRequest(query, body) {
    const { objectType, objectId } = query;
    const { documentUrl } = body;

    const errors = [];

    if (!objectType) errors.push("objectType query parameter is required");
    if (!objectId) errors.push("objectId query parameter is required");
    if (!documentUrl) errors.push("documentUrl in request body is required");

    if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join(', ')}`);
    }

    const fileType = getFileType(documentUrl);
    if (fileType === "unknown") {
        throw new Error("Unsupported file type. Please provide an image or PDF URL.");
    }

    return fileType;
}

// Main analysis function
async function analyzeDocument(body, query) {
    try {
        const { objectType, objectId } = query;
        const { documentUrl, username, password } = body;

        console.log(`📥 Request received for ${objectType} ${objectId}`);

        // Authenticate
        authenticate(body);

        // Validate and get file type
        const fileType = validateRequest(query, body);

        let extractedText;

        if (fileType === "image") {
            extractedText = await analyzeImage(documentUrl);
        } else if (fileType === "pdf") {
            extractedText = await analyzePDF(documentUrl);
        }

        // Update HubSpot property
        const updateResult = await updateProperty(objectType, objectId, extractedText);

        return {
            success: true,
            message: "Document analyzed and HubSpot updated successfully",
            objectType,
            objectId,
            fileType,
            extractedTextLength: extractedText.length,
            preview: extractedText.substring(0, 500) + (extractedText.length > 500 ? "..." : ""),
            hubspotUpdate: {
                id: updateResult.id,
                updatedAt: updateResult.updatedAt
            }
        };

    } catch (error) {
        console.error("❌ API Error:", error);
        throw error;
    }
}

// Analyze document route
app.post('/api/analyze', async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { query, body } = req;

        if (!body || Object.keys(body).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body is required'
            });
        }

        const result = await analyzeDocument(body, query);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Error in analyze handler:', error);

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
});

// Export for Vercel
export default app;

// Start server for local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📊 Extract ID endpoint: http://localhost:${PORT}/api/extract-id?path=YOUR_PATH`);
    });
}