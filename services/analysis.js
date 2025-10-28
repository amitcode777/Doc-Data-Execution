// services/analysis.js
import OpenAI from "openai";
import fs from "fs";
import config from '../config/index.js';
import { ANALYSIS_PROMPT } from '../config/constants.js';
import {
    cleanJSONResponse,
    downloadFile,
    cleanupFile,
    generateTempPath
} from '../utils/helpers.js';

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export const analyzeImage = async (url) => {
    const response = await client.chat.completions.create({
        model: config.OPENAI_CONFIG.model,
        messages: [{
            role: "user",
            content: [
                { type: "text", text: ANALYSIS_PROMPT },
                { type: "image_url", image_url: { url } }
            ]
        }],
        max_tokens: config.OPENAI_CONFIG.maxTokens,
        response_format: { type: "json_object" }
    });

    return JSON.parse(cleanJSONResponse(response.choices[0].message.content));
};

export const analyzePDF = async (url) => {
    const tempPath = generateTempPath(".pdf");
    try {
        await downloadFile(url, tempPath);
        const uploadedFile = await client.files.create({
            file: fs.createReadStream(tempPath),
            purpose: "assistants",
        });

        const response = await client.chat.completions.create({
            model: config.OPENAI_CONFIG.model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: ANALYSIS_PROMPT },
                    { type: "file", file: { file_id: uploadedFile?.id } },
                ]
            }],
            max_tokens: config.OPENAI_CONFIG.maxTokens,
            response_format: { type: "json_object" }
        });

        return JSON.parse(cleanJSONResponse(response?.choices[0]?.message?.content));
    } finally {
        cleanupFile(tempPath);
    }
};

export default {
    analyzeImage,
    analyzePDF
};