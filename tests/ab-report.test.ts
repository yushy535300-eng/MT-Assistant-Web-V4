import { describe, expect, it } from "vitest";
import { abPnlFromPacket, abReportQueryRange, abReportWindow } from "../lib/ab-report";

describe("AB official bet log", () => {
  it("uses Taipei noon-to-noon like the 投注紀錄 filter", () => {
    const { start, end } = abReportWindow(new Date("2026-09-20T22:41:00.000Z"));
    expect(start).toBe(Date.parse("2026-09-20T04:00:00.000Z"));
    expect(end).toBe(Date.parse("2026-09-21T04:00:00.000Z"));
    expect(abReportQueryRange(new Date("2026-09-20T22:41:00.000Z"))).toEqual({
      g: "2026-09-20 12:00:00",
      h: "2026-09-21 12:00:00",
    });
  });

  it("reads personal 今日輸贏 from betLog/records totals, not hall I/M", () => {
    const packet = {
      code: 0,
      message: "ok",
      data: {
        C: [
          { AA: "1", CC: "B501", GG: "2026-09-21 06:41:07", II: "600.00", JJ: "-600.00", LL: "600.00" },
          { AA: "2", CC: "B604", GG: "2026-09-21 06:21:27", II: "1000.00", JJ: "-1000.00", LL: "1000.00" },
          { AA: "3", CC: "B604", GG: "2026-09-21 06:20:01", II: "1000.00", JJ: "950.00", LL: "950.00" },
          { AA: "4", CC: "B604", GG: "2026-09-21 06:19:31", II: "1000.00", JJ: "0.00", LL: "0.00" },
        ],
        G: 4,
        H: "3600.00",
        I: "-650.00",
        M: "-650.00",
      },
    };
    expect(abPnlFromPacket(packet)).toBe(-650);
    expect(
      abPnlFromPacket({
        c: "getGameHall",
        p: { I: [1008, 1009], M: "20163", D: [{ AA: 10, BB: "B201", WW3: [["1"]], JJ: 99, CC: "x" }] },
      })
    ).toBeNull();
  });
});
