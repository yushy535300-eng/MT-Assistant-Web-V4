import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("DG floating assistant lifecycle", () => {
  it("does not force DG offline while entering or leaving the same-session proxy", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../app/index.tsx"), "utf8");
    const enter = source.slice(
      source.indexOf("const enterDgSameSessionProxy="),
      source.indexOf("const leaveDgSameSessionProxy="),
    );
    const leave = source.slice(
      source.indexOf("const leaveDgSameSessionProxy="),
      source.indexOf("// 一進牌路主頁就自動連 MT / DG"),
    );

    expect(enter).not.toContain("setDgConnected(false)");
    expect(leave).not.toContain("setDgConnected(false)");
    expect(enter).not.toContain('setDgStatus("連線中")');
    expect(leave).not.toContain('setDgStatus("連線中")');
  });
});
