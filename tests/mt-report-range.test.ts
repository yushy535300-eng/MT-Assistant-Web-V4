import { describe, expect, it } from "vitest";
import { mtTodayReportRange } from "../lib/mt-report";

describe("MT today report range", () => {
  it("includes Taipei early-morning bets before 08:00", () => {
    const now = new Date("2026-09-20T22:10:00.000Z");
    const range = mtTodayReportRange(now);
    const begin = new Date(range.begin_at).getTime();
    const end = new Date(range.end_at).getTime();
    expect(begin).toBe(Date.parse("2026-09-20T16:00:00.000Z"));
    expect(end).toBe(Date.parse("2026-09-21T15:59:59.000Z"));
    expect(now.getTime()).toBeGreaterThanOrEqual(begin);
    expect(now.getTime()).toBeLessThanOrEqual(end);
  });
});
