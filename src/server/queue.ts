/**
 * Generation is slow and costs a model call, so exactly one runs at a time.
 * Serialising it also means the UI only ever has one thing to report, which is
 * why the progress endpoint can be a poll rather than a websocket.
 */
export interface QueueStatus {
    /** The posting being generated right now, if any. */
    current: string | null;
    /** Ids waiting behind it, in order. */
    pending: string[];
}

export class GenerationQueue {
    private current: string | null = null;
    private readonly pending: string[] = [];
    private tail: Promise<unknown> = Promise.resolve();

    status(): QueueStatus {
        return {current: this.current, pending: [...this.pending]};
    }

    isQueued(id: string): boolean {
        return this.current === id || this.pending.includes(id);
    }

    /**
     * Runs `task` after everything already queued. The returned promise settles
     * with the task's own result, so a caller still sees its own failure.
     */
    enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
        this.pending.push(id);

        const run = this.tail.then(async () => {
            const index = this.pending.indexOf(id);
            if (index !== -1) this.pending.splice(index, 1);
            this.current = id;
            try {
                return await task();
            } finally {
                this.current = null;
            }
        });

        // The chain must not break when a task rejects, or every later job
        // would be dropped with it.
        this.tail = run.catch(() => undefined);
        return run;
    }
}
