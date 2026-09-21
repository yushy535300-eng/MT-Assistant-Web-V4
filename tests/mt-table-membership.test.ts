import { describe, expect, it } from "vitest";
import { collectConfirmedMtTableIds } from "../lib/mt-table-membership";
import { applyLiveTables, applyLiveShowWin, type LiveRoadTable } from "../lib/road-live-state";

describe("MT confirmed table membership", () => {
  const snapshot = [
    { table_id: "BAG07", table_type: "BAS" },
    { table_id: "BAG08", table_type: "BAS" },
    { table_id: "BAV01", table_type: "BAC" },
  ];
  it("includes the captured BAS tables 7/8, without loading placeholders", () => {
    expect(collectConfirmedMtTableIds([], snapshot)).toEqual(["BAG07", "BAG08", "BAV01"]);
    expect(collectConfirmedMtTableIds([], [])).toEqual([]);
  });
  it("keeps confirmed tables across repeated partial and empty snapshots", () => {
    let ids = collectConfirmedMtTableIds([], snapshot);
    for (let i = 0; i < 1000; i++) ids = collectConfirmedMtTableIds(ids, i % 2 ? [] : snapshot.slice(2));
    expect(ids).toEqual(["BAG07", "BAG08", "BAV01"]);
    expect(collectConfirmedMtTableIds(ids, [...snapshot, { table_id: "BAV02", table_type: "BAC" }]))
      .toEqual(["BAG07", "BAG08", "BAV01", "BAV02"]);
  });
  it("preserves omitted BAS roads and applies the next result and dealer update", () => {
    const current: LiveRoadTable[] = ["BAG07", "BAG08"].map(id => ({
      id, apiId: id, name: "原荷官", players: "12", shoe: "100", round: 2,
      banker: 1, player: 1, tie: 0, results: ["莊", "閒"], live: true,
    }));
    const omitted = applyLiveTables(current, [snapshot[2]]);
    expect(omitted).toEqual(current);
    const updated = applyLiveTables(omitted, [{ ...snapshot[0], dealer: { name: "新荷官" } }]);
    expect(updated[0].name).toBe("新荷官");
    expect(updated[0].results).toEqual(["莊", "閒"]);
    const next = applyLiveShowWin(updated, { body: { table_id: "BAG08", shoe: 100, round: 3, winner: 2 } });
    expect(next[1].results).toEqual(["莊", "閒", "莊"]);
    expect(next[1].round).toBe(3);
  });
});
