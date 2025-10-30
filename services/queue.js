// services/queue.js
class MemoryQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.processingCount = 0;
        this.maxConcurrent = 1; // Process one email at a time
    }

    // Add task to queue
    enqueue(task) {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const queueItem = {
            id: taskId,
            task: task,
            status: 'queued',
            addedAt: new Date(),
            startedAt: null,
            completedAt: null,
            error: null
        };

        this.queue.push(queueItem);
        console.log(`📥 Task queued: ${taskId}. Queue length: ${this.queue.length}`);

        // Start processing if not already running
        if (!this.isProcessing) {
            this.processQueue();
        }

        return taskId;
    }

    // Process the queue
    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        console.log(`🔄 Queue processing started. Items in queue: ${this.queue.length}`);

        while (this.queue.length > 0 && this.processingCount < this.maxConcurrent) {
            const queueItem = this.queue.shift();
            this.processingCount++;

            try {
                console.log(`🎯 Processing task: ${queueItem.id}`);
                queueItem.status = 'processing';
                queueItem.startedAt = new Date();

                // Execute the task
                await queueItem.task();

                queueItem.status = 'completed';
                queueItem.completedAt = new Date();
                console.log(`✅ Task completed: ${queueItem.id}`);

            } catch (error) {
                queueItem.status = 'failed';
                queueItem.error = error.message;
                queueItem.completedAt = new Date();
                console.error(`❌ Task failed: ${queueItem.id}`, error);
            } finally {
                this.processingCount--;
            }
        }

        this.isProcessing = false;

        if (this.queue.length > 0) {
            // If there are still items in queue, process them after a short delay
            setTimeout(() => this.processQueue(), 100);
        } else {
            console.log('🏁 Queue processing completed. All tasks finished.');
        }
    }

    // Get queue status
    getStatus() {
        return {
            queued: this.queue.length,
            processing: this.processingCount,
            isProcessing: this.isProcessing,
            totalInSystem: this.queue.length + this.processingCount,
            queueItems: this.queue.map(item => ({
                id: item.id,
                status: item.status,
                addedAt: item.addedAt
            }))
        };
    }

    // Clear queue (optional)
    clear() {
        const clearedCount = this.queue.length;
        this.queue = [];
        console.log(`🧹 Queue cleared. Removed ${clearedCount} items.`);
        return clearedCount;
    }
}

// Create singleton instance
const emailQueue = new MemoryQueue();

export default emailQueue;