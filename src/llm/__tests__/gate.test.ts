import { describe, test, expect } from "vitest";
import { Semaphore } from "../gate.js";

function deferred<T = void>() {
   let resolve!: (v: T) => void;
   const promise = new Promise<T>((r) => (resolve = r));
   return { promise, resolve };
}

describe("Semaphore", () => {
   test("rejects a non-positive limit", () => {
      expect(() => new Semaphore(0)).toThrow();
      expect(() => new Semaphore(1.5)).toThrow();
   });

   test("never exceeds the limit and preserves FIFO order", async () => {
      const sem = new Semaphore(2);
      const order: number[] = [];
      let concurrent = 0;
      let peak = 0;
      const gates = [
         deferred(),
         deferred(),
         deferred(),
         deferred(),
         deferred(),
      ];

      const tasks = gates.map((g, i) =>
         sem.run(async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            order.push(i);
            await g.promise;
            concurrent -= 1;
         }),
      );

      expect(sem.running).toBe(2);
      expect(sem.waiting).toBe(3);
      // Release out of order — waiters must still start FIFO.
      gates[1].resolve();
      await tasks[1];
      gates[0].resolve();
      await tasks[0];
      gates[2].resolve();
      gates[3].resolve();
      gates[4].resolve();
      await Promise.all(tasks);

      expect(peak).toBe(2);
      expect(order).toEqual([0, 1, 2, 3, 4]);
      expect(sem.running).toBe(0);
      expect(sem.waiting).toBe(0);
   });

   test("a late arrival cannot jump ahead of a queued waiter", async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];
      const a = deferred();

      const ta = sem.run(async () => {
         order.push("a");
         await a.promise;
      });
      const tb = sem.run(async () => {
         order.push("b");
      });
      a.resolve();
      // c arrives while b's slot handoff is pending — must run after b.
      const tc = sem.run(async () => {
         order.push("c");
      });
      await Promise.all([ta, tb, tc]);
      expect(order).toEqual(["a", "b", "c"]);
   });

   test("onWait fires only when the task actually queues", async () => {
      const sem = new Semaphore(1);
      let waited = 0;
      const g = deferred();
      const t1 = sem.run(async () => g.promise, { onWait: () => waited++ });
      expect(waited).toBe(0);
      const t2 = sem.run(async () => {}, { onWait: () => waited++ });
      expect(waited).toBe(1);
      g.resolve();
      await Promise.all([t1, t2]);
   });

   test("a rejecting task releases its slot", async () => {
      const sem = new Semaphore(1);
      await expect(
         sem.run(async () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      await expect(sem.run(async () => "ok")).resolves.toBe("ok");
      expect(sem.running).toBe(0);
   });
});
