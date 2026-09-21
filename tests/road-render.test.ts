import { describe, expect, it } from "vitest";

import { buildAskRoad, buildBeadGrid, buildBeadWindow, buildBigRoad, buildDerivedRoad, buildRoadWindow } from "../lib/road-render";
import { applyLiveShowWin, type LiveRoadTable, type RoadResult } from "../lib/road-live-state";

function table(): LiveRoadTable {
  return { id: "03", apiId: "BAG03", name: "03", players: "0", shoe: "17035", round: 30, banker: 0, player: 1, tie: 0, results: ["閒"], live: true };
}

describe("official baccarat road render builders", () => {
  it("feeds a real BAG03 show_win result into bead and Big Road marks", () => {
    const updated = applyLiveShowWin([table()], { body: { table_id: "BAG03", shoe: 17035, round: 31, winner: 2 } })[0];
    expect(buildBeadWindow(updated.results)).toEqual(["閒", "莊"]);
    expect(buildBigRoad(updated.results).map(({ row, col, result }) => ({ row, col, result }))).toEqual([
      { row: 0, col: 0, result: "閒" },
      { row: 0, col: 1, result: "莊" },
    ]);
  });

  it("keeps the bead window at the latest 36 outcomes", () => {
    const results: Array<"莊" | "閒"> = Array.from({ length: 40 }, (_, index) => (index % 2 ? "莊" : "閒"));
    expect(buildBeadWindow(results)).toHaveLength(36);
    expect(buildBeadWindow(results)[0]).toBe(results[4]);
  });

  it("opens the Bead Plate top-to-bottom and shifts one complete left column at outcome 37", () => {
    const results: RoadResult[] = Array.from({ length: 37 }, (_, index) => (index % 2 ? "莊" : "閒"));
    const grid = buildBeadGrid(results);
    expect(grid).toHaveLength(36);
    expect(grid[0]).toBe(results[1]);
    expect(grid[5]).toBe(results[7]);
    expect(grid[6]).toBe(results[2]);
    expect(grid[35]).toBe(results[36]);
  });

  it("attaches ties to the previous Big Road mark instead of opening a new cell", () => {
    const marks = buildBigRoad(["莊", "莊", "和", "莊"]);
    expect(marks).toHaveLength(3);
    expect(marks[1].tieCount).toBe(1);
    expect(marks[2]).toMatchObject({ col: 0, row: 2, result: "莊" });
  });

  it("keeps Banker and Player outcomes in one shared Big Road coordinate system", () => {
    const marks = buildBigRoad(["莊", "莊", "閒", "閒", "莊", "莊", "閒"]);
    expect(marks.map(({ col, row, result }) => ({ col, row, result }))).toEqual([
      { col: 0, row: 0, result: "莊" },
      { col: 0, row: 1, result: "莊" },
      { col: 1, row: 0, result: "閒" },
      { col: 1, row: 1, result: "閒" },
      { col: 2, row: 0, result: "莊" },
      { col: 2, row: 1, result: "莊" },
      { col: 3, row: 0, result: "閒" },
    ]);
  });

  it("turns a dragon right at row six and bends before an occupied tail", () => {
    const marks = buildBigRoad(["莊", "莊", "莊", "莊", "莊", "莊", "莊", "莊", "閒", "閒", "閒", "閒", "閒", "閒"]);
    expect(marks[6]).toMatchObject({ col: 1, row: 5 });
    expect(marks[7]).toMatchObject({ col: 2, row: 5 });
    expect(marks[13]).toMatchObject({ col: 2, row: 4, result: "閒" });
  });

  it("uses one-, two-, and three-column official lookback rules for derived roads", () => {
    const shoe: RoadResult[] = ["莊", "莊", "閒", "閒", "莊", "莊", "閒", "閒"];
    expect(buildDerivedRoad(shoe, 1, false).map((mark) => mark.result)).toEqual(["莊", "莊", "莊", "莊", "莊"]);
    expect(buildDerivedRoad(shoe, 2, true).map((mark) => mark.result)).toEqual(["莊", "莊", "莊"]);
    expect(buildDerivedRoad(shoe, 3, false).map((mark) => mark.result)).toEqual(["莊"]);
  });

  it("calculates banker/player ask-road from two hypothetical next entries on the same Big Road", () => {
    const ask = buildAskRoad(["莊", "莊", "閒", "閒", "莊"]);
    expect(ask.banker.bigEye).toBe("莊");
    expect(ask.player.bigEye).toBe("閒");
    expect(ask.banker.small).toBe("莊");
    expect(ask.player.small).toBe("閒");
  });

  it("keeps each of the three lower roads as an independent right-aligned nine-column horizontal segment", () => {
    const results: RoadResult[] = Array.from({ length: 42 }, (_, index) => (index % 2 ? "莊" : "閒"));
    const roads = [buildDerivedRoad(results, 1, false), buildDerivedRoad(results, 2, true), buildDerivedRoad(results, 3, false)];
    for (const road of roads) {
      const visible = buildRoadWindow(road, 9);
      expect(visible.every((mark) => mark.col >= 0 && mark.col < 9 && mark.row >= 0 && mark.row < 6)).toBe(true);
    }
  });

  it("keeps Big Road and all derived roads within the visible six rows", () => {
    const results: RoadResult[] = ["閒", "閒", "莊", "莊", "莊", "和", "閒", "閒", "莊", "閒", "莊", "莊", "閒"];
    const roads = [buildBigRoad(results), buildDerivedRoad(results, 1, false), buildDerivedRoad(results, 2, true), buildDerivedRoad(results, 3, false)];
    expect(roads.flat().every((mark) => mark.row >= 0 && mark.row <= 5)).toBe(true);
  });
});
