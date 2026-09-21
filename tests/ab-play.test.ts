import { describe, expect, it } from "vitest";
import { abPlayTableUpdate, abSeatedIdsMatch, abSettleTableIds } from "../lib/ab-play";

describe("歐博進桌與開獎桌", () => {
  it("進桌請求用 p.a 記住桌號", () => {
    expect(abPlayTableUpdate({ c: "enterGameTable", p: { a: 76, b: 100 } })).toEqual({
      join: ["76"],
      leave: false,
    });
  });
  it("進桌回覆用桌代碼 C202 與內部 AA", () => {
    expect(
      abPlayTableUpdate({
        c: "enterGameTable",
        p: { A: 0, B: "", C: { AA: 76, BB: "C202" } },
      }),
    ).toEqual({ join: ["C202", "76"], leave: false });
  });
  it("離桌要清掉", () => {
    expect(abPlayTableUpdate({ c: "leaveGameTable", p: {} })).toEqual({
      join: [],
      leave: true,
    });
  });
  it("大廳推播不算進桌", () => {
    expect(abPlayTableUpdate({ c: "getGameHall", p: { D: [] } })).toEqual({
      join: [],
      leave: false,
    });
  });
  it("只有你坐的那桌開出路紙才算結算", () => {
    const seated = new Set(["C202", "76"]);
    expect(
      abSeatedIdsMatch(
        seated,
        abSettleTableIds({ c: "pushGameTableResults", p: { A: 76, G: [["x"]] } }),
      ),
    ).toBe(true);
    expect(
      abSeatedIdsMatch(
        seated,
        abSettleTableIds({ c: "pushGameTableResults", p: { A: 10 } }),
      ),
    ).toBe(false);
    expect(abSettleTableIds({ c: "pushGameStatus", p: { A: [{ AA: 76 }] } })).toEqual([]);
  });
});
