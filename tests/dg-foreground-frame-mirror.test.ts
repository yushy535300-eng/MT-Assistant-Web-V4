import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("DG foreground frame mirror", () => {
  it("feeds the exact frames received by the DG page into the floating relay", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "server/dg-game-proxy.ts"), "utf8");
    expect(source).toContain("void __mirrorFrame(event.data)");
    expect(source).toContain('fetch(\\"/api/dg/proxy/frames\\"');
    expect(source).toContain('raw.startsWith("http://")||raw.startsWith("https://")');
    expect(source).toContain("u.hostname===location.hostname");
    expect(source).toContain('HTMLScriptElement.prototype,"src"');
    expect(source).not.toContain('/^https?:\\/\\//i.test(raw)');
    expect(source).toContain('app.post("/api/dg/proxy/frames"');
    expect(source).toContain("relay.ingestBridgeFrame(data)");
    expect(source).toContain('/(?:^|\\/)index\\.html$/i.test(target.pathname)');
    expect(source).not.toContain('next=scheme+\\"//\\"+location.host+\\"/api/dg/game-ws');
    const relay = fs.readFileSync(path.resolve(process.cwd(), "server/dg-relay.ts"), "utf8");
    expect(relay).toContain('this.transportMode = "bridge"');
    expect(relay).toContain('this.setStatus("connected", "DG 網頁即時封包已接通")');
  });
});
