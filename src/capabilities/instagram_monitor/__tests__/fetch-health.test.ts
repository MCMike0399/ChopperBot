import { describe, expect, it, vi } from "vitest";
import { SqliteMemoryStore } from "../../../memory/store.js";
import {
   InstagramMonitorStore,
   INSTAGRAM_MONITOR_MIGRATIONS,
} from "../store.js";
import {
   InstagramFetchHealth,
   FETCH_ALERT_REPEAT_MS,
   FETCH_ALERT_RETRY_MS,
   fetchHealthStatus,
} from "../fetch-health.js";

async function fixture() {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   await memory.migrate("instagram_monitor", INSTAGRAM_MONITOR_MIGRATIONS);
   const store = new InstagramMonitorStore(memory.db());
   const notify = vi.fn(async () => true);
   return {
      memory,
      store,
      notify,
      health: new InstagramFetchHealth(store, notify),
   };
}
const NOW = Date.parse("2026-10-18T18:00:00Z");

function failThree(health: InstagramFetchHealth) {
   for (const name of ["one", "two", "three"])
      health.recordFailure(name, "unexpected", NOW);
}

describe("persistent Instagram fetch health", () => {
   it("survives scheduler restarts/backoff resets and deduplicates outage alerts", async () => {
      const { memory, store, notify, health } = await fixture();
      try {
         failThree(health);
         await health.flush(NOW);
         expect(notify).toHaveBeenCalledTimes(1);
         store.clearFailureBackoff();
         const restarted = new InstagramFetchHealth(
            new InstagramMonitorStore(memory.db()),
            notify,
         );
         expect(fetchHealthStatus(store.readFetchHealth())).toBe("degraded");
         await restarted.flush(NOW + FETCH_ALERT_RETRY_MS);
         expect(notify).toHaveBeenCalledTimes(1);
         await restarted.flush(NOW + FETCH_ALERT_REPEAT_MS);
         expect(notify).toHaveBeenCalledTimes(2);
      } finally {
         memory.close();
      }
   });

   it("retries failed delivery without another IG poll and persists recovery until delivery", async () => {
      const { memory, store, notify, health } = await fixture();
      try {
         failThree(health);
         notify.mockResolvedValueOnce(false);
         await health.flush(NOW);
         expect(store.readFetchHealth().alertedAt).toBeNull();
         const restarted = new InstagramFetchHealth(store, notify);
         await restarted.flush(NOW + 1);
         expect(notify).toHaveBeenCalledTimes(1);
         const retryAt = NOW + FETCH_ALERT_RETRY_MS;
         await restarted.flush(retryAt);
         expect(store.readFetchHealth().alertedAt).toBe(retryAt);
         health.recordSuccess("four", retryAt + 1);
         notify.mockRejectedValueOnce(new Error("Discord unavailable"));
         await expect(health.flush(retryAt + 1)).rejects.toThrow(
            "Discord unavailable",
         );
         expect(store.readFetchHealth().recoveryPending).toBe(true);
         await restarted.flush(retryAt + 1 + FETCH_ALERT_RETRY_MS);
         expect(notify).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: "recovered" }),
         );
         expect(store.readFetchHealth().recoveryPending).toBe(false);
         expect(store.readFetchHealth().alertedAt).toBeNull();
         await restarted.flush(retryAt + 2 * FETCH_ALERT_RETRY_MS);
         expect(notify).toHaveBeenCalledTimes(4);
      } finally {
         memory.close();
      }
   });

   it("does not infer an outage from quiet time, no pushes, or a recovered transient failure", async () => {
      const { memory, store, notify, health } = await fixture();
      try {
         expect(fetchHealthStatus(store.readFetchHealth())).toBe("unknown");
         await health.flush(NOW);
         health.recordFailure("one", "unexpected", NOW);
         health.recordFailure("two", "unexpected", NOW);
         health.recordSuccess("three", NOW + 1); // a successful empty feed is healthy
         await health.flush(NOW + FETCH_ALERT_REPEAT_MS * 10);
         expect(notify).not.toHaveBeenCalled();
         expect(fetchHealthStatus(store.readFetchHealth())).toBe("ok");
      } finally {
         memory.close();
      }
   });

   it("keeps dedicated auth/throttle/account alerts separate", async () => {
      const { memory, store, notify, health } = await fixture();
      try {
         for (const kind of ["auth", "rate", "html", "account"] as const) {
            health.recordSuccess("one", NOW);
            for (let n = 0; n < 3; n++) health.recordFailure("one", kind, NOW);
            await health.flush(NOW);
         }
         expect(fetchHealthStatus(store.readFetchHealth())).toBe("degraded");
         expect(notify).not.toHaveBeenCalled();
      } finally {
         memory.close();
      }
   });
});
