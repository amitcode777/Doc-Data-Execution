import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";

// Load environment variables (for local development)
if (process.env.NODE_ENV !== 'production') {
    import('dotenv').then(dotenv => dotenv.config());
}

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

// Set CORS headers
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Helper: download file temporarily
async function downloadFile(url, outputPath) {
    const response = await axios.get(url, { 
        responseType: "arraybuffer",
        maxContentLength: 10 * 1024 * 1024 // 10MB limit
    });
    
    // Ensure directory exists
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
    return `/tmp/file_${timestamp}_${random}${extension}`; // Use /tmp for Vercel
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

// 🖼 Analyze Image – extract only visible text
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

// 📄 Analyze PDF – summarize or extract text
async function analyzePDF(url) {
    console.log("📄 Downloading and analyzing PDF...");

    const tempPath = generateTempPath(".pdf");
    
    try {
        await downloadFile(url, tempPath);

        // Upload PDF to OpenAI
        const uploadedFile = await client.files.create({
            file: fs.createReadStream(tempPath),
            purpose: "assistants",
        });

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Extract all readable text from this PDF. Respond only with the text content.",
                        },
                        {
                            type: "file",
                            file: { file_id: uploadedFile.id },
                        },
                    ],
                },
            ],
        });

        const result = response.choices[0].message.content.trim();
        console.log("📚 PDF Text Length:", result.length);
        
        return result;
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
                "test_property": propertyValue.substring(0, 20000) // HubSpot character limit
            }
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to update ${objectType}: ${response.status} ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
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

    // Validate file type
    const fileType = getFileType(documentUrl);
    if (fileType === "unknown") {
        throw new Error("Unsupported file type. Please provide an image or PDF URL.");
    }

    return fileType;
}

// Main analysis function
export async function analyzeDocument(body, query) {
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

export function healthCheck() {
    return {
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Document Analysis API",
        environment: process.env.NODE_ENV || "development"
    };
}

export function getApiInfo() {
    return {
        service: "Document Analysis API",
        version: "1.0.0",
        endpoints: {
            "POST /api/analyze": {
                description: "Analyze document and update HubSpot",
                queryParameters: {
                    objectType: "HubSpot object type (e.g., contacts, companies)",
                    objectId: "HubSpot object ID"
                },
                body: {
                    username: "API username",
                    password: "API password",
                    documentUrl: "URL of the image or PDF to analyze"
                }
            },
            "GET /api/health": "Health check endpoint",
            "GET /api": "API information"
        }
    };
}