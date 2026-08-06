/**
 * Global in-process serializer for every topic-file mutation, reindex
 * included: two browser tabs saving concurrently cannot interleave their
 * read-modify-write cycles, and a full rescan never reads files while a
 * mutation is in flight. Single-user tool — one queue is enough.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => {});
    return run;
  }
}
