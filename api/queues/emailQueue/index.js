import { Queue } from "@vercel/queues";

// Define your queue name (must match vercel.json)
export const emailQueue = new Queue("emailQueue");
