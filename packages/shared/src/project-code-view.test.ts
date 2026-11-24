import { describe, expect, it } from "vitest";
import { readProjectCodeViewMetadata } from "./project-code-view.js";

describe("readProjectCodeViewMetadata", () => {
  it("is null unless codeView.enabled is exactly true", () => {
    expect(readProjectCodeViewMetadata(null)).toBeNull();
    expect(readProjectCodeViewMetadata({})).toBeNull();
    expect(readProjectCodeViewMetadata({ codeView: { enabled: "true" } })).toBeNull();
    expect(readProjectCodeViewMetadata({ codeView: { enabled: false } })).toBeNull();
  });

  it("fills missing fields with null for an enabled workspace", () => {
    expect(readProjectCodeViewMetadata({ codeView: { enabled: true } })).toEqual({
      enabled: true, lastUpdatedAt: null, lastResult: null, lastError: null, head: null,
    });
  });

  it("keeps known values and drops an unknown result", () => {
    expect(readProjectCodeViewMetadata({
      codeView: { enabled: true, lastUpdatedAt: "2026-11-24T00:00:00.000Z", lastResult: "weird", lastError: "x", head: "abc1234" },
    })).toEqual({ enabled: true, lastUpdatedAt: "2026-11-24T00:00:00.000Z", lastResult: null, lastError: "x", head: "abc1234" });
    expect(readProjectCodeViewMetadata({ codeView: { enabled: true, lastResult: "skipped_dirty" } })?.lastResult).toBe("skipped_dirty");
  });
});
