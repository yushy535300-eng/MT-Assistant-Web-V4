import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("DG mobile launch route", () => {
  it("proxies ddnewwap and resolves both desktop and mobile base paths", () => {
    const relay = fs.readFileSync(path.resolve(process.cwd(), "server/dg-relay.ts"), "utf8");
    const proxy = fs.readFileSync(path.resolve(process.cwd(), "server/dg-game-proxy.ts"), "utf8");
    expect(relay).toContain("ddnew(?:pc|wap)");
    expect(proxy).toContain('app.use("/ddnewwap", proxyHandler)');
  });
});
