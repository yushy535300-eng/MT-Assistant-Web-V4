import { describe, expect, it } from "vitest";

function mapDgRoadCode(code: number): "莊" | "閒" | "和" | null {
  if (code >= 1 && code <= 4) return "莊";
  if (code >= 5 && code <= 8) return "閒";
  if (code >= 9 && code <= 12) return "和";
  return null;
}

describe("DG baccarat road winner codes", () => {
  it("uses the DG four-code winner groups", () => {
    for (const code of [1, 2, 3, 4]) expect(mapDgRoadCode(code)).toBe("莊");
    for (const code of [5, 6, 7, 8]) expect(mapDgRoadCode(code)).toBe("閒");
    for (const code of [9, 10, 11, 12]) expect(mapDgRoadCode(code)).toBe("和");
  });
});


function parseCapturedDgRoads(roads: string[]): Array<"莊" | "閒" | "和"> {
  return [...roads].reverse().map((raw) => {
    const code = Number(raw.split("#")[1] ?? raw.split("#")[0]);
    return mapDgRoadCode(code);
  }).filter((x): x is "莊" | "閒" | "和" => x !== null);
}

describe("DG road transport order", () => {
  it("normalizes the captured newest-first DG list into chronological oldest-first play order", () => {
    // Captured DG list: newest -> oldest = 9,1,5,5,3,1,5.
    // DG screen chronology must therefore be: 閒,莊,莊,閒,閒,莊,和.
    expect(parseCapturedDgRoads(["#9", "#1", "#5", "#5", "#3", "#1", "#5"]))
      .toEqual(["閒", "莊", "莊", "閒", "閒", "莊", "和"]);
  });
});
