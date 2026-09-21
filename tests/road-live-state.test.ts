import { describe, expect, it } from "vitest";

import {
  applyLiveShowWin,
  applyLiveTables,
  applyLiveWait,
  isMtBaccaratTable,
  parseBeadPlate,
  type LiveRoadTable,
} from "../lib/road-live-state";

function table(): LiveRoadTable {
  return {
    id: "03",
    apiId: "BAG03",
    name: "—",
    players: "—",
    shoe: "17035",
    round: 30,
    banker: 0,
    player: 1,
    tie: 0,
    results: ["閒"],
    live: true,
  };
}

describe("real-time baccarat road state", () => {
  it("parses the confirmed bead_plate2 two-digit result encoding", () => {
    expect(parseBeadPlate("0102,03")).toEqual(["閒", "莊", "和"]);
  });

  it("immediately adds the confirmed BAG03 show_win outcome and ignores a duplicate", () => {
    const payload = { body: { room_id: 31, round: 31, shoe: 17035, table_id: "BAG03", winner: 2 } };
    const first = applyLiveShowWin([table()], payload);
    expect(first[0].results).toEqual(["閒", "莊"]);
    expect(first[0].banker).toBe(1);
    expect(first[0].lastResultKey).toBe("17035|31");

    const duplicate = applyLiveShowWin(first, payload);
    expect(duplicate[0].results).toEqual(["閒", "莊"]);
  });

  it("keeps a just-received result when same-shoe tablesvg trend is temporarily behind", () => {
    const immediate = applyLiveShowWin([table()], { body: { shoe: 17035, round: 31, table_id: "BAG03", winner: 2 } });
    const corrected = applyLiveTables(immediate, [{ table_id: "BAG03", table_name: "03", shoe: "17035", round: "31", trend: { current_shoe: "17035", current_round: "31", bead_plate2: "01" } }]);
    expect(corrected[0].results).toEqual(["閒", "莊"]);
  });

  it("uses server trend after it catches up and does not trust show_win alone to reset a shoe", () => {
    const immediate = applyLiveShowWin([table()], { body: { shoe: 17035, round: 31, table_id: "BAG03", winner: 2 } });
    const caughtUp = applyLiveTables(immediate, [{ table_id: "BAG03", table_name: "03", shoe: "17035", round: "31", trend: { current_shoe: "17035", current_round: "31", bead_plate2: "0102" } }]);
    expect(caughtUp[0].results).toEqual(["閒", "莊"]);

    const nextShoe = applyLiveShowWin(caughtUp, { body: { shoe: 17036, round: 1, table_id: "BAG03", winner: 1 } });
    expect(nextShoe[0].results).toEqual(["閒", "莊", "閒"]);
    expect(nextShoe[0].shoe).toBe("17035");
  });

  it("updates BAG wait metadata, including the real red countdown, but ignores non-BAG events", () => {
    const waited = applyLiveWait([table()], { body: { table_id: "BAG03", shoe: 17035, round: 33, count: 22 } }, ["BAG03"]);
    expect(waited[0].round).toBe(33);
    expect(waited[0].countdown).toBe(22);
    expect(waited[0].countdownUpdatedAt).toBeTypeOf("number");

    const synchronized = applyLiveTables(waited, [{ table_id: "BAG03", totalplayers: 782, trend: { current_shoe: "17035", current_round: "33", bead_plate2: "01" } }]);
    expect(synchronized[0].countdown).toBe(22);
    expect(synchronized[0].countdownUpdatedAt).toBe(waited[0].countdownUpdatedAt);

    const ignored = applyLiveWait(waited, { body: { table_id: "DTG02", shoe: 6848, round: 41 } }, ["BAG03"]);
    expect(ignored[0].round).toBe(33);
  });

  it("uses real totalplayers and dealer nickname from a full table response", () => {
    const merged = applyLiveTables([table()], [{
      table_id: "BAG03", table_name: "03", totalplayers: 782, room_id: 31,
      dealer: { nick_name: "中文", username: "fallback", avatar_url: "https://dealer.example/avatar.png" },
      trend: { current_shoe: "17035", current_round: "33", bead_plate2: "01" },
    }]);
    expect(merged[0].players).toBe("782");
    expect(merged[0].name).toBe("中文");
    expect(merged[0].roomId).toBe("31");
    expect(merged[0].dealerPhoto).toBe("https://dealer.example/avatar.png");
  });

  it("accepts international BAC tables and updates their dealer and live road", () => {
    const international: LiveRoadTable = {
      ...table(), id: "BAV01", apiId: "BAV01", shoe: "—", round: 0, results: [], player: 0,
    };
    const merged = applyLiveTables([international], [{
      table_id: "BAV01", table_type: "BAC", totalplayers: 96, room_id: 47,
      dealer: { nick_name: "Sky", avatar_url: "https://dealer.example/sky.png" },
      trend: { current_shoe: "20260918-8", current_round: 2, bead_plate2: "0102" },
    }]);
    expect(merged[0].name).toBe("Sky");
    expect(merged[0].dealerPhoto).toBe("https://dealer.example/sky.png");
    expect(merged[0].results).toEqual(["閒", "莊"]);

    const won = applyLiveShowWin(merged, { body: { table_id: "BAV01", shoe: "20260918-8", round: 3, winner: 3 } });
    expect(won[0].results).toEqual(["閒", "莊", "和"]);
    const waited = applyLiveWait(won, { body: { table_id: "BAV01", round: 4, count: 18 } }, ["BAV01"]);
    expect(waited[0].countdown).toBe(18);
  });

  it("identifies BAC membership from table_type while excluding non-baccarat tables", () => {
    expect(isMtBaccaratTable({ table_id: "SBG01", table_type: "BAC" })).toBe(true);
    expect(isMtBaccaratTable({ table_id: "BAV08" })).toBe(true);
    expect(isMtBaccaratTable({ table_id: "DTG02", table_type: "DT" })).toBe(false);
  });
});
