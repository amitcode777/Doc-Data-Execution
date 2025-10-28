// config/constants.js
export const ANALYSIS_PROMPT = `Extract structured data from Swiss residence/work permit documents. Output ONLY valid JSON without markdown. Use null for missing fields.

Required JSON:
{
  "firstName": "First name from document",
  "lastName": "Last name from document", 
  "streetAddress": "Street + house number + postal code + city",
  "dateOfBirth": "DD.MM.YYYY",
  "nationality": "Nationality",
  "workPermitDate": "Work Permit expiration (DD.MM.YYYY)",
  "workPermitType": "Type of permit"
}`;

export const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
export const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf"];

export const ERROR_MESSAGES = {
    MISSING_ENV: '❌ Missing required environment variables',
    INVALID_WEBHOOK: 'Invalid webhook data received',
    UNSUPPORTED_FILE_TYPE: 'Unsupported file type',
    FILE_PROCESSING_FAILED: 'File processing failed'
};

export const SUCCESS_MESSAGES = {
    DOCUMENT_ANALYZED: 'Document analyzed and HubSpot updated successfully',
    EMAIL_SENT: 'Email sent successfully'
};