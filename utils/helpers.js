// utils/helpers.js
import fs from "fs";
import path from "path";
import axios from "axios";

// Use fs.promises for async file operations
const fsAsync = fs.promises;

export const downloadAndSaveFile = async (signedUrl, fileId) => {
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file ${fileId}: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Create temporary file with proper extension
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const fileExtension = path.extname(new URL(signedUrl).pathname) || '.pdf';
  const tempFilePath = path.join(tempDir, `hubspot_file_${fileId}_${Date.now()}${fileExtension}`);

  // Use fs.promises.writeFile for async operation
  await fsAsync.writeFile(tempFilePath, buffer);
  return tempFilePath;
};

export const cleanupTempFiles = async (filePaths) => {
  const cleanupPromises = filePaths.map(async (filePath) => {
    try {
      await fsAsync.unlink(filePath);
      console.log(`Cleaned up temp file: ${filePath}`);
    } catch (error) {
      console.error(`Error cleaning up temp file ${filePath}:`, error);
    }
  });

  await Promise.allSettled(cleanupPromises);
};

// Other helper functions remain the same
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

export const getFileType = (url) => {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
    if ([".pdf"].includes(ext)) return "pdf";
    return "unknown";
  } catch (error) {
    console.error('Error getting file type:', error);
    return "unknown";
  }
};

export const generateTempPath = (extension = ".tmp") => 
  `/tmp/file_${Date.now()}_${Math.random().toString(36).substring(2, 15)}${extension}`;

export const cleanupFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error cleaning up file:', error);
  }
};

export const parseFileRecordString = (inputString) => {
  try {
    const parts = inputString.split(',');
    if (parts.length !== 3) throw new Error('Invalid input format');
    const [fileId, objectTypeId, recordId] = parts.map(part => part.trim());
    if (!fileId || !objectTypeId || !recordId) throw new Error('All parts must be non-empty');
    return { fileId, objectTypeId, recordId };
  } catch (error) {
    console.error('Error parsing file record string:', error);
    throw new Error(`Invalid file record format: ${error.message}`);
  }
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