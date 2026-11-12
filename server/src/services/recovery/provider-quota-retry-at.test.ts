import { describe, expect, it } from "vitest";
import { resolveProviderQuotaRetryAt } from "./provider-quota-retry-at.js";

const now = new Date("2026-11-12T07:00:00Z");

describe("resolveProviderQuotaRetryAt", () => {
  it("persisted future retryNotBefore wins", () => {
    const result = resolveProviderQuotaRetryAt(
      {
        error: "usage limit reached, resets 8pm (Asia/Bangkok)",
        resultJson: { retryNotBefore: "2026-11-12T09:30:00.000Z" },
      },
      now,
    );
    expect(result.retryAt.toISOString()).toBe("2026-11-12T09:30:00.000Z");
    expect(result.parsedResetTime).toBe(true);
  });

  it("ignores a persisted time that is already past", () => {
    const result = resolveProviderQuotaRetryAt(
      { error: "no time here", resultJson: { retryNotBefore: "2026-11-12T06:00:00.000Z" } },
      now,
      1000,
    );
    expect(result.parsedResetTime).toBe(false);
    expect(result.retryAt.getTime()).toBe(now.getTime() + 1000);
  });

  it('parses "resets 8pm (Asia/Bangkok)"', () => {
    const result = resolveProviderQuotaRetryAt(
      { error: "You've hit your limit - resets 8pm (Asia/Bangkok)", resultJson: null },
      now,
    );
    expect(result.retryAt.toISOString()).toBe("2026-11-12T13:00:00.000Z");
    expect(result.parsedResetTime).toBe(true);
  });

  it("falls back to default backoff", () => {
    const result = resolveProviderQuotaRetryAt({ error: "usage limit reached", resultJson: {} }, now, 5000);
    expect(result.parsedResetTime).toBe(false);
    expect(result.retryAt.getTime()).toBe(now.getTime() + 5000);
  });
});
