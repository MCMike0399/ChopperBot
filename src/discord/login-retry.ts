import { log } from "../log.js";

export function isTransientDns(error: unknown): boolean {
   for (let i = 0; i < 8 && error && typeof error === "object"; i++) {
      const e = error as { code?: string; cause?: unknown };
      if (e.code === "EAI_AGAIN") return true;
      error = e.cause;
   }
   return false;
}

/** Retry transient startup DNS before exiting. Never marks a shutdown clean:
 * exhausted retries still fail startup and preserve crash-restart truth.
 */
export async function loginWithDnsRetry(
   login: () => Promise<unknown>,
   sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
   const delays = [1000, 3000, 7000, 15000, 30000];
   for (let attempt = 0; ; attempt++) {
      try {
         await login();
         return;
      } catch (err) {
         if (!isTransientDns(err) || attempt >= delays.length) throw err;
         log.warn(
            { attempt: attempt + 1, delayMs: delays[attempt] },
            "discord.login_dns_retry",
         );
         await sleep(delays[attempt]);
      }
   }
}
