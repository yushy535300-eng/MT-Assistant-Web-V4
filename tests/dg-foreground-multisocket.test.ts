import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("DG foreground multi-socket bridge", () => {
  it("keeps one authenticated upstream and filters duplicate page login", () => {
    const relay = fs.readFileSync(path.resolve(process.cwd(), "server/dg-relay.ts"), "utf8");
    const proxy = fs.readFileSync(path.resolve(process.cwd(), "server/dg-game-proxy.ts"), "utf8");

    expect(relay).toContain("bootstrapFrames = new Map");
    expect(relay).toContain("cmd === 10086 || cmd === 45 || cmd === 2");
    expect(relay).toContain("this.bootstrapFrames.get(responseCmd)");
    expect(relay).toContain("return this.ws.sendBinary(data)");
    expect(relay).not.toContain('this.transportMode = "bridge"');
    expect(relay).not.toContain("openForegroundSocket(targetUrl: string");
    expect(proxy).toContain("relay.forwardForegroundFrame(queue[0]!, writeLocal)");
    expect(proxy).toContain("relay.attachForegroundBridgeSink(writeLocal)");
  });
});
