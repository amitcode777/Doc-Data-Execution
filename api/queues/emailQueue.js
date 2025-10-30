import { Queue } from "@vercel/queue";

export const emailQueue = new Queue("emailQueue");
