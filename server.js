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
app.use(express.json({ limit: '10mb' }));

// Configuration
const config = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN,
    auth: {
        username: process.env.API_USERNAME,
        password: process.env.API_PASSWORD
    }
};

// Validate required environment variables
if (!config.openaiApiKey) {
    console.error("❌ OPENAI_API_KEY is required");
    process.exit(1);
}

if (!config.hubspotToken) {
    console.error("❌ HUBSPOT_ACCESS_TOKEN is required");
    process.exit(1);
}

// Initialize OpenAI client
const client = new OpenAI({
    apiKey: config.openaiApiKey,
});

// ==================== ROUTES ====================

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Document Analysis API',
        version: '1.0.0',
        endpoints: {
            'POST /api/analyze': 'Analyze document from webhook data',
            'POST /webhook/hubspot': 'HubSpot webhook endpoint',
            'GET /api/health': 'Health check'
        }
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Helper: download file temporarily
async function downloadFile(url, outputPath) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        maxContentLength: 10 * 1024 * 1024,
        timeout: 30000
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

function parseFileRecordString(inputString) {
    // Split the string by commas
    const parts = inputString.split(',');

    // Validate that we have exactly 3 parts
    if (parts.length !== 3) {
        throw new Error(`Invalid input format. Expected 3 parts separated by commas, got ${parts.length}`);
    }

    const [fileId, objectTypeId, recordId] = parts;

    // Validate that none of the parts are empty
    if (!fileId || !objectTypeId || !recordId) {
        throw new Error('Invalid input: All parts (fileId, objectTypeId, recordId) must be non-empty');
    }

    // Return as an object with named properties
    return {
        fileId: fileId.trim(),
        objectTypeId: objectTypeId.trim(),
        recordId: recordId.trim()
    };
}

// Get signed URL from HubSpot file ID
async function getSignedFileUrl(fileId) {
    console.log(`📁 Getting signed URL for file ID: ${fileId}`);
    
    const url = `https://api.hubapi.com/files/v3/files/${fileId}/signed-url`;
    const options = {
        method: 'GET', 
        headers: {
            Authorization: `Bearer ${config.hubspotToken}`,
            'Content-Type': 'application/json'
        }
    };

    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ HubSpot API error:', errorData);
        throw new Error(`Failed to get signed URL: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.url) {
        throw new Error('No URL found in HubSpot response');
    }
    
    console.log('✅ Got signed URL successfully');
    return data.url;
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
                    - "Name / Nom / Cognome" → lastName
                    - "Vorname / Prénom / Nome" → firstName
                    - "Geburtsdatum / Date de naissance / Data di nascita" → dateOfBirth
                    - "Staatsangehörigkeit / Nationalité / Nazionalità" → nationality
                    - "Kontrollfrist", "Gültig bis", or "Expiration" → workPermitDate
                    - "Niederlassungsbewilligung", "Aufenthaltsbewilligung", or "Kurzaufenthaltsbewilligung" → workPermitType
                    - Address is usually near "Strasse / Rue / Via" and may contain a postal code (e.g., 5103 Wildegg).
                    `;

        // 4️⃣ Send to GPT model
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
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
                "extracted_data": JSON.stringify(propertyValue)
            },
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("❌ Failed to update property:", errorData);
        throw new Error(`HubSpot update failed: ${response.status}`);
    }

    const data = await response.json();
    console.log("✅ Successfully updated HubSpot property");
    return data;
}

// Main analysis function for webhook
async function processWebhookData(webhookData) {
    try {
        console.log('🔔 Processing webhook data...');
        
        // Extract the first event from webhook array
        const event = webhookData[0];
        if (!event) {
            throw new Error('No event data found in webhook');
        }

        // Get and parse the propertyValue
        const { propertyValue, objectId } = event;
        
        if (!propertyValue) {
            throw new Error('propertyValue is missing in webhook data');
        }

        console.log(`📥 Raw propertyValue: ${propertyValue}`);
        
        // Parse the file record string
        const { fileId, objectTypeId, recordId } = parseFileRecordString(propertyValue);
        
        console.log(`📋 Parsed values:`, { fileId, objectTypeId, recordId });

        // Get signed URL from HubSpot
        const documentUrl = await getSignedFileUrl(fileId);
        
        // Detect file type
        const fileType = getFileType(documentUrl);
        if (fileType === "unknown") {
            throw new Error("Unsupported file type from HubSpot file");
        }

        console.log(`📄 File type detected: ${fileType}`);
        console.log(`🔗 Document URL: ${documentUrl}`);

        let extractedData;

        // Analyze document based on type
        if (fileType === "image") {
            extractedData = await analyzeImage(documentUrl);
        } else if (fileType === "pdf") {
            extractedData = await analyzePDF(documentUrl);
        }

        // Update HubSpot record (using objectTypeId and recordId from parsed string)
        const updateResult = await updateProperty(objectTypeId, recordId, extractedData);

        return {
            success: true,
            message: "Document analyzed and HubSpot updated successfully",
            webhookEventId: event.eventId,
            parsedData: {
                fileId,
                objectTypeId, 
                recordId
            },
            fileType,
            analysisPreview: typeof extractedData === 'string' 
                ? extractedData.substring(0, 200) + '...'
                : JSON.stringify(extractedData).substring(0, 200) + '...',
            hubspotUpdate: {
                id: updateResult.id,
                updatedAt: updateResult.updatedAt
            }
        };

    } catch (error) {
        console.error("❌ Webhook processing error:", error);
        throw error;
    }
}

// Webhook endpoint for HubSpot
app.post('/webhook/hubspot', async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const webhookData = req.body;

        if (!webhookData || !Array.isArray(webhookData) || webhookData.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid webhook data: expected array with at least one event'
            });
        }

        console.log('📨 Webhook received:', {
            eventId: webhookData[0].eventId,
            objectId: webhookData[0].objectId,
            propertyName: webhookData[0].propertyName
        });

        const result = await processWebhookData(webhookData);
        
        return res.status(200).json(result);
        
    } catch (error) {
        console.error('Error in webhook handler:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
            eventId: req.body?.[0]?.eventId
        });
    }
});

// Legacy analyze endpoint (for backward compatibility)
app.post('/api/analyze', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // This endpoint now also expects webhook format
        const result = await processWebhookData(req.body);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Error in analyze handler:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Export for Vercel
export default app;

// Start server for local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📨 Webhook endpoint: http://localhost:${PORT}/webhook/hubspot`);
        console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    });
}