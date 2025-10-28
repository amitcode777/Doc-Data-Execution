// utils/helpers.js
import fs from "fs";
import path from "path";
import axios from "axios";

export const cleanJSONResponse = (responseText) => {
    const cleaned = responseText?.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned?.match(/\{[\s\S]*\}/);
    return jsonMatch ? jsonMatch[0] : cleaned;
};

export const downloadFile = async (url, outputPath) => {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, response.data);
};

export const downloadAndSaveFile = async (signedUrl, fileId) => {
    const response = await fetch(signedUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const extension = path.extname(new URL(signedUrl).pathname) || '.pdf';
    const tempPath = path.join(tempDir, `file_${fileId}_${Date.now()}${extension}`);

    await fs.writeFile(tempPath, buffer);
    return tempPath;
};

export const getFileType = (url) => {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
    if ([".pdf"].includes(ext)) return "pdf";
    return "unknown";
};

export const generateTempPath = (ext = ".tmp") =>
    `/tmp/file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}${ext}`;

export const cleanupFile = (filePath) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

export const cleanupTempFiles = async (filePaths) => {
    await Promise.allSettled(
        filePaths.map(filePath =>
            fs.unlink(filePath).catch(() => console.error(`Cleanup failed: ${filePath}`))
        )
    );
};

export const parseFileRecordString = (inputString) => {
    const [fileId, objectTypeId, recordId] = inputString.split(',').map(p => p.trim());
    if (!fileId || !objectTypeId || !recordId) throw new Error('Invalid file record format');
    return { fileId, objectTypeId, recordId };
};

export default {
    cleanJSONResponse,
    downloadFile,
    downloadAndSaveFile,
    getFileType,
    generateTempPath,
    cleanupFile,
    cleanupTempFiles,
    parseFileRecordString
};