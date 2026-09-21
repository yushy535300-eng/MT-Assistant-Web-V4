import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { dgReportDay, isDgPnlReply, parseDgDailyPnl, platformTodayPnl } from "../lib/dg-report";
import { DgRelay, parsePublicBean } from "../server/dg-relay";
import { DG_REPORT_BRIDGE_SCRIPT } from "../server/dg-report-bridge";

const now = Date.parse("2026-09-18T13:39:00Z");
// Sanitized structure from the supplied DG HAR. No tokens or account details.
const captured = { cmd: 13, codeId: 0, lobbyId: 0, tableId: 0, type: 1,
  list: ["", "", "12", "1"], dList: [0, 0, 0],
  object: '{"records":[],"pageCount":0,"pageSize":12,"pageNow":1,"rowCount":0}' };
function stringField(f: number, s: string) {
  const b = Buffer.from(s); return Buffer.concat([Buffer.from([(f << 3) | 2, b.length]), b]);
}
function reply(values: number[], packed = false, size = "11") {
  const doubles = values.map(n => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; });
  return Buffer.concat([Buffer.from([8, 13, 24, 0, 80, 1]),
    ...(packed ? [Buffer.from([74, doubles.length * 8]), ...doubles] : doubles.flatMap(b => [Buffer.from([73]), b])),
    ...["", "", size, "1"].map(s => stringField(12, s)), stringField(14, '{"records":[]}')]);
}

describe("DG daily report isolation", () => {
  it("accepts the captured empty report as a genuine zero", () => {
    expect(parseDgDailyPnl(captured, "2026-09-18", now)?.value).toBe(0);
  });
  it("takes the total's third value, without summing records or using balance", () => {
    expect(parseDgDailyPnl({ ...captured, dList: [1000, 900, -125.5], balance: 9999 }, "2026-09-18", now)?.value).toBe(-125.5);
    expect(parseDgDailyPnl({ ...captured, dList: [1000, 900, 95] }, "2026-09-18", now)?.value).toBe(95);
  });
  it("rejects transactions, errors, filtered reports and malformed totals", () => {
    for (const patch of [{ type: 2 }, { codeId: 3 }, { lobbyId: 1 }, { tableId: 1 }, { dList: [0] }, { dList: [0, 0, NaN] }, { object: "{}" }]) {
      expect(parseDgDailyPnl({ ...captured, ...patch }, "2026-09-18", now)).toBeNull();
    }
  });
  it("does not accept yesterday's response as today's total", () => {
    expect(parseDgDailyPnl(captured, "2026-09-17", now)).toBeNull();
    expect(dgReportDay(Date.parse("2026-09-18T16:00:00Z"))).toBe("2026-09-19");
  });
  it("never falls back to MT in DG and keeps MT unchanged", () => {
    const report = parseDgDailyPnl(captured, "2026-09-18", now);
    expect(platformTodayPnl("DG", 999, null, now)).toBeNull();
    expect(platformTodayPnl("DG", 999, report, now)).toBe(0);
    expect(platformTodayPnl("MT", 999, report, now)).toBe(999);
    expect(platformTodayPnl("DG", 999, report, now + 86400000)).toBeNull();
  });
  it("decodes protobuf doubles in packed and unpacked forms", () => {
    for (const packed of [false, true]) {
      const bean = parsePublicBean(reply([1000, 900, -125.5], packed));
      expect(bean.dList).toEqual([1000, 900, -125.5]);
      expect(isDgPnlReply(bean)).toBe(true);
    }
    expect(isDgPnlReply(captured)).toBe(false);
  });
  it("requests and publishes DG totals through the existing relay, with throttling", () => {
    const relay: any = new DgRelay("test-session", "https://example.com/ddnewpc/index.html?token=test-only");
    relay.status = "connected";
    const chunks: string[] = [];
    relay.subscribe({ write: (s: string) => chunks.push(s) });
    const request = parsePublicBean(relay.createPnlRequest());
    expect(request.cmd).toBe(13);
    expect(request.object).toBe("1");
    expect(request.list).toEqual(["", "", "11", "1"]);
    expect(relay.createPnlRequest()).toBeNull();
    relay.ingestBridgeFrame(reply([500, 500, 95]));
    expect(chunks.some(s => s.includes('event: pnl') && s.includes('"value":95'))).toBe(true);
    const count = chunks.length;
    relay.ingestBridgeFrame(reply([500, 500, -999], false, "12"));
    expect(chunks.length).toBe(count);
    relay.ingestBridgeFrame(reply([500, 500, -999])); // duplicate has no pending request
    expect(chunks.length).toBe(count);
  });
  it("uses a two-second report cadence and immediately follows a new full road", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "server/dg-relay.ts"), "utf8");
    const bridge = fs.readFileSync(path.resolve(process.cwd(), "server/dg-report-bridge.ts"), "utf8");
    expect(source).toContain("now - this.lastPnlRequestAt < 2000");
    expect(source).toContain("now - this.pnlRequest.at < 6000");
    expect(source).toContain("this.requestDailyPnl();");
    expect(bridge).toContain("setInterval(__pnlPoll,2000)");
  });
  it("polls only an authenticated existing browser socket and hides only assistant replies", async () => {
    const sent: unknown[] = [];
    let tick: (() => void) | undefined;
    const ws = { readyState: 1 };
    const context: any = { Uint8Array, ArrayBuffer, TextDecoder, JSON,
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      NativeWS: { prototype: { send(this: unknown, b: unknown) { expect(this).toBe(ws); sent.push(b); } } },
      fetch: async () => ({ ok: true, json: async () => ({ frame: Buffer.from([8, 13]).toString("base64") }) }),
      setInterval: (f: () => void) => { tick = f; return 1; }, clearInterval: () => {},
      setTimeout: () => 1, window: { addEventListener: () => {} },
    };
    vm.createContext(context);
    vm.runInContext(DG_REPORT_BRIDGE_SCRIPT + ';globalThis.receive=__pnlReceive;globalThis.poll=__pnlPoll;', context);
    await context.poll(); expect(sent).toHaveLength(0);
    context.receive(ws, { data: Uint8Array.from([8, 230, 78, 24, 0]) }); // cmd 10086 success
    await context.poll(); expect(sent).toHaveLength(1);
    expect(tick).toBeTypeOf("function");
    let stopped = 0;
    context.receive(ws, { data: reply([0, 0, 0]), stopImmediatePropagation: () => stopped++ });
    context.receive(ws, { data: reply([0, 0, 0], false, "12"), stopImmediatePropagation: () => stopped++ });
    expect(stopped).toBe(1);
    ws.readyState = 3; await context.poll(); expect(sent).toHaveLength(1);
  });
});
