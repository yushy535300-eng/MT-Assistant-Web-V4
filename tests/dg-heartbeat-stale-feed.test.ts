import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("DG live-feed heartbeat", () => {
  it("matches the captured 3-second native heartbeat and recovers without login", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "server/dg-relay.ts"), "utf8");
    const timerStart = source.indexOf("this.keepaliveTimer = setInterval");
    const timerEnd = source.indexOf("}, 3000);", timerStart);
    const block = source.slice(timerStart, timerEnd + 10);

    expect(timerStart).toBeGreaterThan(-1);
    expect(timerEnd).toBeGreaterThan(timerStart);
    expect(block).toContain("this.send(99)");
    expect(block).toContain("now - this.lastVendorPacketAt <= 9000");
    expect(block).toContain("this.send(2, { lobbyId: 5, type: 0 })");
    expect(block).toContain('this.setStatus("connecting", "DG 即時資料逾時，正在原連線恢復...")');
    expect(block).not.toContain("this.send(10086");
    expect(source).toContain('this.setStatus("connected", "DG 即時資料已恢復")');
  });
});
