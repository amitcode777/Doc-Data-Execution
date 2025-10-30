import { Queue } from "@vercel/queue";

// Define your queue name (must match vercel.json)
export const emailQueue = new Queue("emailQueue");
