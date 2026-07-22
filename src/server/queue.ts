/**
 * Generation is slow and costs a model call, so exactly one runs at a time.
 * Serialising it also means the UI only ever has one thing to report, which is
 * why the progress endpoint can be a poll rather than a websocket.
 *
 * The queue is in memory, deliberately. It describes what this process is doing
 * right now; it is not a work log. A restart forgets it — which is exactly why
 * `resetInterruptedGenerations()` runs at startup, so nothing is left sitting in
 * `generating` with no process behind it.
 */

/** A posting waiting its turn, or the one running. Position 0 is running. */
export interface QueueEntry {
    sourceId: string;
    company: string | null;
    title: string;
    enqueuedAt: string;
    position: number;
}

export interface QueueLabel {
    company: string | null;
    title: string;
}

export interface QueueStatus {
    /** The posting being generated right now, if any. */
    current: string | null;
    /** Ids waiting behind it, in order. */
    pending: string[];
    /** Everything running or waiting, running first. */
    entries: QueueEntry[];
}

export class QueueError extends Error {
    override readonly name = "QueueError";
}

interface Waiting {
    sourceId: string;
    label: QueueLabel;
    enqueuedAt: string;
    /** Set when the entry is cancelled before its turn arrives. */
    cancelled?: boolean;
}

export class GenerationQueue {
    private current: Waiting | null = null;
    private readonly pending: Waiting[] = [];
    private tail: Promise<unknown> = Promise.resolve();

    status(): QueueStatus {
        const entries: QueueEntry[] = [];
        if (this.current) entries.push({...this.entryOf(this.current), position: 0});
        this.pending.forEach((waiting, index) => {
            entries.push({...this.entryOf(waiting), position: index + 1});
        });

        return {
            current: this.current?.sourceId ?? null,
            pending: this.pending.map((waiting) => waiting.sourceId),
            entries,
        };
    }

    private entryOf(waiting: Waiting): Omit<QueueEntry, "position"> {
        return {
            sourceId: waiting.sourceId,
            company: waiting.label.company,
            title: waiting.label.title,
            enqueuedAt: waiting.enqueuedAt,
        };
    }

    isQueued(id: string): boolean {
        return this.current?.sourceId === id || this.pending.some((one) => one.sourceId === id);
    }

    isRunning(id: string): boolean {
        return this.current?.sourceId === id;
    }

    /**
     * Drops a posting that has not started yet. The one already running cannot
     * be cancelled: the model call is in flight and stopping it here would only
     * hide it, not end it.
     */
    cancel(id: string): boolean {
        if (this.isRunning(id)) {
            throw new QueueError(
                `"${id}" is already generating and cannot be cancelled. It will finish shortly.`,
            );
        }

        const index = this.pending.findIndex((one) => one.sourceId === id);
        if (index === -1) return false;

        // Marked as well as spliced: the task closure is already chained behind
        // the tail, and it checks this before doing any work.
        const [removed] = this.pending.splice(index, 1);
        if (removed) removed.cancelled = true;
        return true;
    }

    /**
     * Runs `task` after everything already queued. The returned promise settles
     * with the task's own result, so a caller still sees its own failure.
     */
    enqueue<T>(id: string, label: QueueLabel, task: () => Promise<T>): Promise<T> {
        if (this.isQueued(id)) {
            throw new QueueError(`"${id}" is already queued.`);
        }

        const waiting: Waiting = {
            sourceId: id,
            label,
            enqueuedAt: new Date().toISOString(),
        };
        this.pending.push(waiting);

        const run = this.tail.then(async () => {
            const index = this.pending.indexOf(waiting);
            if (index !== -1) this.pending.splice(index, 1);
            if (waiting.cancelled) throw new QueueError(`"${id}" was cancelled before it ran.`);

            this.current = waiting;
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
