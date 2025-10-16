import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import express from "express";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize OpenAI client
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Express app
const app = express();
app.use(express.json());

// Dummy credentials (in production, use a proper database)
const VALID_USERS = {
    [process.env.API_USERNAME || "admin"]: process.env.API_PASSWORD || "password123"
};

// Authentication middleware
function authenticate(req, res, next) {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            error: "Missing username or password in request body"
        });
    }

    if (!VALID_USERS[username] || VALID_USERS[username] !== password) {
        return res.status(401).json({
            error: "Invalid credentials"
        });
    }

    next();
}

// Helper: download file temporarily
async function downloadFile(url, outputPath) {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    fs.writeFileSync(outputPath, response.data);
}

// Detect file type from URL
function getFileType(url) {
    const ext = path.extname(url).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
    if ([".pdf"].includes(ext)) return "pdf";
    return "unknown";
}

// 🖼 Analyze Image – extract only visible text
async function analyzeImage(url) {
    console.log("🖼️ Analyzing image from URL...\n");

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
    console.log("> 📝 Extracted Text:\n", result);

    return result;
}

// 📄 Analyze PDF – summarize or extract text
async function analyzePDF(url) {
    console.log("📄 Downloading and analyzing PDF...\n");

    const tempPath = "./temp.pdf";
    await downloadFile(url, tempPath);

    // Upload PDF to OpenAI
    const uploadedFile = await client.files.create({
        file: fs.createReadStream(tempPath),
        purpose: "assistants",
    });

    // Use correct structure for file in messages
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
    console.log("📚 PDF Text:\n", result);

    // Clean up temporary file
    if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
    }

    return result;
}

async function updateProperty(objectType, objectId, propertyValue) {
    const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${objectId}`;

    const response = await fetch(url, {
        method: "PATCH",
        headers: {
            "Authorization": `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            properties: {
                "test_property": propertyValue
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

// API endpoint with query parameters and body authentication
app.post("/analyze-document", authenticate, async (req, res) => {
    try {
        const { objectType, objectId } = req.query;
        const { documentUrl } = req.body;

        // Validate input
        if (!objectType || !objectId) {
            return res.status(400).json({
                error: "Missing required query parameters: objectType, objectId"
            });
        }

        if (!documentUrl) {
            return res.status(400).json({
                error: "Missing required field in body: documentUrl"
            });
        }

        console.log(`📥 Request received for ${objectType} ${objectId}`);

        const type = getFileType(documentUrl);
        let extractedText = null;

        if (type === "image") {
            extractedText = await analyzeImage(documentUrl);
        } else if (type === "pdf") {
            extractedText = await analyzePDF(documentUrl);
        } else {
            return res.status(400).json({
                error: "Unsupported file type. Please provide an image or PDF URL."
            });
        }

        // Update HubSpot property
        const updateResult = await updateProperty(objectType, objectId, extractedText);

        res.json({
            success: true,
            message: "Document analyzed and HubSpot updated successfully",
            objectType,
            objectId,
            extractedTextLength: extractedText.length,
            preview: extractedText.substring(0, 500) + (extractedText.length > 500 ? "..." : ""),
            hubspotUpdate: {
                id: updateResult.id,
                updatedAt: updateResult.updatedAt
            }
        });

    } catch (error) {
        console.error("❌ API Error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint (no authentication required)
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Document Analysis API"
    });
});

// Documentation endpoint
app.get("/", (req, res) => {
    res.json({
        service: "Document Analysis API",
        version: "1.0.0",
        endpoints: {
            "POST /analyze-document": {
                description: "Analyze document and update HubSpot",
                queryParameters: {
                    objectType: "HubSpot object type (e.g., contacts, companies)",
                    objectId: "HubSpot object ID"
                },
                body: {
                    username: "API username",
                    password: "API password",
                    documentUrl: "URL of the image or PDF to analyze"
                },
                example: {
                    curl: `curl -X POST http://localhost:${process.env.PORT || 3000}/analyze-document?objectType=contacts&objectId=123 \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "admin",
    "password": "password123", 
    "documentUrl": "https://example.com/document.pdf"
  }'`
                }
            },
            "GET /health": "Health check endpoint"
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Document Analysis API running on port ${PORT}`);
    console.log(`🔐 Authentication via request body`);
    console.log(`📚 API documentation available at http://localhost:${PORT}/`);
});