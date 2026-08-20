import { describe, test, expect } from "vitest";
import { TurnQueue, QueueBusyError } from "../turn-queue.js";

function deferred<T = void>() {
   let resolve!: (v: T) => void;
   const promise = new Promise<T>((r) => (resolve = r));
   return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TurnQueue", () => {
   test("same channel runs strictly FIFO even with capacity to spare", async () => {
      const q = new TurnQueue({ maxConcurrent: 4 });
      const order: string[] = [];
      const g1 = deferred();

      const t1 = q.run("chan", async () => {
         order.push("start1");
         await g1.promise;
         order.push("end1");
      });
      const t2 = q.run("chan", async () => {
         order.push("start2");
      });
      await tick();
      expect(order).toEqual(["start1"]); // t2 must not have started
      g1.resolve();
      await Promise.all([t1, t2]);
      expect(order).toEqual(["start1", "end1", "start2"]);
   });

   test("different channels run concurrently up to the global cap", async () => {
      const q = new TurnQueue({ maxConcurrent: 2 });
      let concurrent = 0;
      let peak = 0;
      const gates = [deferred(), deferred(), deferred()];
      const mk = (i: number) =>
         q.run(`chan-${i}`, async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await gates[i].promise;
            concurrent -= 1;
         });
      const tasks = [mk(0), mk(1), mk(2)];
      await tick();
      expect(peak).toBe(2);
      gates.forEach((g) => g.resolve());
      await Promise.all(tasks);
      expect(peak).toBe(2);
      expect(q.running).toBe(0);
      expect(q.queued).toBe(0);
   });

   test("a failed turn does not block the next one in the channel", async () => {
      const q = new TurnQueue({ maxConcurrent: 1 });
      const t1 = q.run("chan", async () => {
         throw new Error("boom");
      });
      const t2 = q.run("chan", async () => "ok");
      await expect(t1).rejects.toThrow("boom");
      await expect(t2).resolves.toBe("ok");
   });

   test("onQueued fires for the waiting task, not the first", async () => {
      const q = new TurnQueue({ maxConcurrent: 1 });
      let queued = 0;
      const g = deferred();
      const t1 = q.run("chan", async () => g.promise, {
         onQueued: () => queued++,
      });
      expect(queued).toBe(0);
      const t2 = q.run("other", async () => {}, { onQueued: () => queued++ });
      expect(queued).toBe(1);
      g.resolve();
      await Promise.all([t1, t2]);
   });

   test("per-channel backlog cap throws QueueBusyError", async () => {
      const q = new TurnQueue({ maxConcurrent: 1, maxQueuedPerChannel: 1 });
      const g = deferred();
      const t1 = q.run("chan", async () => g.promise);
      const t2 = q.run("chan", async () => {});
      expect(() => q.run("chan", async () => {})).toThrow(QueueBusyError);
      g.resolve();
      await Promise.all([t1, t2]);
      // Once drained, the channel accepts work again.
      await expect(q.run("chan", async () => "ok")).resolves.toBe("ok");
   });
});
