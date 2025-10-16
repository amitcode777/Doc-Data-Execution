import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import readline from "readline";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper: download file temporarily
async function downloadFile(url, outputPath) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(outputPath, response.data);
}

// Detect file type from URL
function getFileType(url) {
  const ext = path.extname(url).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
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
            text:
              "Read and extract only the exact visible text from this image. Respond only with the text content exactly as it appears.",
          },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  });

  const result = response.choices[0].message.content.trim();
  console.log("> 📝 Extracted Text:\n", result);
  fs.writeFileSync("output.txt", result);
  console.log("\n✅ Result saved to output.txt");
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
            text:
              "Extract all readable text from this PDF. Respond only with the text content.",
          },
          {
            type: "file",
            file: { file_id: uploadedFile.id }, // ✅ Must be file_id inside object
          },
        ],
      },
    ],
  });

  const result = response.choices[0].message.content.trim();
  console.log("📚 PDF Text:\n", result);
  fs.writeFileSync("output.txt", result);

  fs.unlinkSync(tempPath);
  console.log("\n✅ Result saved to output.txt");
}




// Main function
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Enter an image or PDF URL: ", async (url) => {
    try {
      const type = getFileType(url);

      if (type === "image") {
        await analyzeImage(url);
      } else if (type === "pdf") {
        await analyzePDF(url);
      } else {
        console.log("❌ Unsupported file type. Please provide an image or PDF URL.");
      }
    } catch (err) {
      console.error("❌ Error:", err);
    } finally {
      rl.close();
    }
  });
}

main();
