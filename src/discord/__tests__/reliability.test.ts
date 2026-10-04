import { test, expect, vi } from "vitest";
import { ErrorReplyGuard } from "../error-replies.js";
import { loginWithDnsRetry } from "../login-retry.js";

test("seventeen identical failures in one channel yield one reply, other channels and later recovery remain usable", () => {
   const guard = new ErrorReplyGuard(300000);
   expect(
      Array.from({ length: 17 }, (_, i) =>
         guard.allow("channel", "error", 1000 + i),
      ).filter(Boolean),
   ).toHaveLength(1);
   expect(guard.allow("other", "error", 1100)).toBe(true);
   expect(guard.allow("channel", "different error", 1100)).toBe(true);
   expect(guard.allow("channel", "error", 301001)).toBe(true);
});
test("startup transient DNS recovers before exit; wrong-token failures never retry", async () => {
   const login = vi
      .fn()
      .mockRejectedValueOnce({ code: "EAI_AGAIN" })
      .mockRejectedValueOnce({ cause: { code: "EAI_AGAIN" } })
      .mockResolvedValue("ready");
   const sleep = vi.fn(async () => {});
   await loginWithDnsRetry(login, sleep);
   expect(login).toHaveBeenCalledTimes(3);
   expect(sleep.mock.calls).toEqual([[1000], [3000]]);
   const auth = vi.fn(async () => {
      throw { code: "TokenInvalid" };
   });
   await expect(loginWithDnsRetry(auth, sleep)).rejects.toEqual({
      code: "TokenInvalid",
   });
   expect(auth).toHaveBeenCalledTimes(1);
});
test("persistent DNS failure exits truthfully after the bounded delays", async () => {
   const failure = { code: "EAI_AGAIN" },
      login = vi.fn(async () => {
         throw failure;
      }),
      sleep = vi.fn(async () => {});
   await expect(loginWithDnsRetry(login, sleep)).rejects.toBe(failure);
   expect(login).toHaveBeenCalledTimes(6);
   expect(sleep.mock.calls).toEqual([[1000], [3000], [7000], [15000], [30000]]);
});
