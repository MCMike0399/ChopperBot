/** Fetch outcomes are distinct from scheduler liveness and publication volume. */
export const FETCH_FAILURE_ALERT_THRESHOLD = 3;
export const FETCH_ALERT_REPEAT_MS = 6 * 60 * 60_000;
export const FETCH_ALERT_RETRY_MS = 5 * 60_000;

export type FetchFailureKind =
   "unexpected" | "auth" | "rate" | "html" | "account";

export interface FetchHealthState {
   lastAttemptAt: number | null;
   lastSuccessAt: number | null;
   failures: number;
   failureStartedAt: number | null;
   lastAccount: string | null;
   lastFailureKind: FetchFailureKind | null;
   /** Last successfully delivered outage alert; also marks an open incident. */
   alertedAt: number | null;
   lastNotifyAttemptAt: number | null;
   recoveryPending: boolean;
}

export function emptyFetchHealth(): FetchHealthState {
   return {
      lastAttemptAt: null,
      lastSuccessAt: null,
      failures: 0,
      failureStartedAt: null,
      lastAccount: null,
      lastFailureKind: null,
      alertedAt: null,
      lastNotifyAttemptAt: null,
      recoveryPending: false,
   };
}

export function parseFetchHealth(
   raw: string | null | undefined,
): FetchHealthState {
   if (!raw) return emptyFetchHealth();
   try {
      return { ...emptyFetchHealth(), ...JSON.parse(raw) };
   } catch {
      return emptyFetchHealth();
   }
}

export function fetchHealthStatus(
   state: FetchHealthState,
): "unknown" | "ok" | "retrying" | "degraded" {
   if (state.failures >= FETCH_FAILURE_ALERT_THRESHOLD) return "degraded";
   if (state.failures > 0) return "retrying";
   return state.lastSuccessAt === null ? "unknown" : "ok";
}

export interface FetchHealthNotice {
   kind: "failed" | "recovered";
   health: FetchHealthState;
}

/** Return true only after delivery, so a failed Discord send remains retryable. */
export type NotifyFetchHealthFn = (
   notice: FetchHealthNotice,
) => Promise<boolean>;

interface Repository {
   readFetchHealth(): FetchHealthState;
   writeFetchHealth(state: FetchHealthState): void;
}

/** No timers or Instagram probes: observes ordinary polls and uses the existing tick. */
export class InstagramFetchHealth {
   constructor(
      private readonly repository: Repository,
      private readonly notify?: NotifyFetchHealthFn,
   ) {}

   recordFailure(account: string, kind: FetchFailureKind, now: number): void {
      const state = this.repository.readFetchHealth();
      this.repository.writeFetchHealth({
         ...state,
         lastAttemptAt: now,
         failures: state.failures + 1,
         failureStartedAt: state.failures === 0 ? now : state.failureStartedAt,
         lastAccount: account,
         lastFailureKind: kind,
         recoveryPending: false,
      });
   }

   recordSuccess(account: string, now: number): void {
      const state = this.repository.readFetchHealth();
      const justRecovered = state.failures > 0 && state.alertedAt !== null;
      this.repository.writeFetchHealth({
         ...state,
         lastAttemptAt: now,
         lastSuccessAt: now,
         failures: 0,
         failureStartedAt: null,
         lastAccount: account,
         lastFailureKind: null,
         recoveryPending: justRecovered || state.recoveryPending,
         lastNotifyAttemptAt: justRecovered ? null : state.lastNotifyAttemptAt,
      });
   }

   async flush(now: number): Promise<FetchHealthNotice["kind"] | null> {
      if (!this.notify) return null;
      const state = this.repository.readFetchHealth();
      if (
         state.lastNotifyAttemptAt !== null &&
         now - state.lastNotifyAttemptAt < FETCH_ALERT_RETRY_MS
      )
         return null;
      const recovering = state.recoveryPending && state.failures === 0;
      // Auth/throttle/account failures already have dedicated alerts and guardrails.
      const failing =
         state.failures >= FETCH_FAILURE_ALERT_THRESHOLD &&
         state.lastFailureKind === "unexpected" &&
         (state.alertedAt === null ||
            now - state.alertedAt >= FETCH_ALERT_REPEAT_MS);
      if (!recovering && !failing) return null;
      const kind = recovering ? "recovered" : "failed";
      const attempted = { ...state, lastNotifyAttemptAt: now };
      this.repository.writeFetchHealth(attempted);
      if (!(await this.notify({ kind, health: attempted }))) return null;
      this.repository.writeFetchHealth({
         ...attempted,
         alertedAt: recovering ? null : now,
         recoveryPending: false,
      });
      return kind;
   }
}
