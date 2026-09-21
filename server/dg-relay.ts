import tls, { type TLSSocket } from "node:tls";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { DG_PNL_REPORT_LIST, dgReportDay, isDgPnlReply, parseDgDailyPnl, type DgDailyPnl } from "../lib/dg-report";

export type DgRoadResult = "莊" | "閒" | "和";
export type DgTableSnapshot = {
  id: string;
  apiId: string;
  game: string;
  name: string;
  players: string;
  countdown?: number;
  countdownUpdatedAt?: number;
  roomId?: string;
  tableBadge?: string;
  shoe: string;
  round: number;
  banker: number;
  player: number;
  tie: number;
  results: DgRoadResult[];
  trend: string;
  live?: boolean;
  dealerPhoto?: string;
  streamUrl?: string;
  lastUpdated?: number;
  lastResultKey?: string;
  poker?: string;
};

type RelayStatus = "idle" | "connecting" | "connected" | "error" | "closed";
type PublicBean = {
  cmd?: number;
  token?: string;
  codeId?: number;
  lobbyId?: number;
  gameNo?: string;
  tableId?: number;
  seat?: number;
  mid?: number;
  type?: number;
  userName?: string;
  list?: string[];
  dList?: number[];
  object?: string;
  table?: DgRawTable[];
};
type DgRawDealer = { id?: number; name?: string; no?: string; photo?: string; gender?: number; online?: boolean; tableId?: number; state?: number; type?: number };
type DgRawTable = {
  tableId?: number; shoeId?: number; playId?: number; state?: number; countDown?: number;
  result?: string; poker?: string; tel?: string[]; ext?: string[]; roads?: string[]; gameNo?: string;
  fms?: string; tableName?: string; vipName?: string; totalAmount?: number; onlineCount?: number;
  dealer?: DgRawDealer; gameId?: number; anchor?: DgRawDealer;
};

type SseClient = { write: (chunk: string) => unknown };

const WS_KEY_TEXT = "63dwReOhAlDbUoXiMFyZPgSvQc4JnTr7La0EjWf3Cu6NzBt9Ks1HxGq2Rd8Ym5Vp".split("").reverse().join("");
const WS_KEY_24 = Buffer.from(WS_KEY_TEXT.slice(0, 24), "utf8");
const DEFAULT_DG_WS = "wss://appatw.kindlestone.com";
// Verified in the user's latest HAR on 2026-09-17:
// Origin https://new-dd-cn.20299999.com -> 101 Switching Protocols on newappa0.ywjxi.com.
// Keep this as a transport fallback only; the runtime still prefers values
// returned by DG's own game_settings.json.
const HAR_VERIFIED_DG_WS = "wss://newappa0.ywjxi.com";
const LEGACY_OVERSEAS_DG_WS = "wss://hwdata-new.taxyss.com";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encryptDgToken(plain: string) {
  const cipher = createCipheriv("des-ede3", WS_KEY_24, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("base64");
}

/**
 * DG validates the `sign` query against the literal Base64 text produced by
 * its browser bundle.  Do not pass this value through encodeURIComponent:
 * the vendor's successful handshake keeps `/`, `+` and the trailing `=`
 * characters verbatim (confirmed by the 2026-09-17 DG-page HAR).
 */
export function signedDgWsUrl(wsUrl: string, token: string) {
  const base = wsUrl.replace(/\/$/, "");
  return `${base}/?sign=${encryptDgToken(token)}`;
}

function extractToken(gameUrl: string) {
  try { return new URL(gameUrl).searchParams.get("token") || ""; }
  catch { return String(gameUrl || "").match(/[?&]token=([^&#]+)/i)?.[1] ? decodeURIComponent(String(gameUrl).match(/[?&]token=([^&#]+)/i)![1]) : ""; }
}

type DgLaunchInfo = {
  launchUrl: string;
  origin: string;
  basePath: string;
  token: string;
  jsonType: number;
};

function cleanHtmlUrl(value: string) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function findNavigationUrl(html: string, base: URL, token: string) {
  const patterns = [
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)["']/i,
    /["']([^"']*\/ddnew(?:pc|wap)\/index\.html\?[^"']+)["']/i,
    /["'](index\.html\?[^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    try {
      const next = new URL(cleanHtmlUrl(m[1]), base);
      if (next.protocol !== "https:") continue;
      if (!next.searchParams.get("token") && token) next.searchParams.set("token", token);
      return next;
    } catch {}
  }
  return null;
}

/**
 * Resolve the one-time DG direct1 URL the same way the vendor page does.
 * We deliberately do not pin a historical DG host or a region. The final
 * index.html query's `type` is the value the DG bundle itself uses to pick
 * game_wss / game_wss_overseas / game_wss_* (verified from the captured JS).
 */
async function resolveDgLaunch(gameUrl: string): Promise<DgLaunchInfo> {
  const original = new URL(gameUrl);
  const token = original.searchParams.get("token") || extractToken(gameUrl);
  if (!token) throw new Error("DG 授權網址缺少 token");
  let current = new URL(original.toString());
  const seen = new Set<string>();

  for (let step = 0; step < 5; step++) {
    if (seen.has(current.toString())) break;
    seen.add(current.toString());
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(7000),
      });
    } catch {
      break;
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try { current = new URL(location, current); continue; } catch { break; }
    }

    const contentType = response.headers.get("content-type") || "";
    if (/text\/html/i.test(contentType)) {
      try {
        const html = await response.text();
        const next = findNavigationUrl(html, current, token);
        if (next && next.toString() !== current.toString()) { current = next; continue; }
      } catch {}
    }
    break;
  }

  if (!current.searchParams.get("token")) current.searchParams.set("token", token);
  const rawType = Number(current.searchParams.get("type"));
  // This mirrors DG's bundle exactly: jsonType defaults to 0 and only accepts 0..5.
  const jsonType = Number.isInteger(rawType) && rawType >= 0 && rawType <= 5 ? rawType : 0;
  const match = current.pathname.match(/^(.*?\/ddnew(?:pc|wap))(?=\/|$)/i);
  const basePath = match?.[1]?.replace(/\/$/, "") || "/ddnewpc";
  return { launchUrl: current.toString(), origin: current.origin, basePath, token, jsonType };
}

function primaryWsForType(pc: any, jsonType: number) {
  switch (jsonType) {
    case 1: return pc?.game_wss_overseas;
    case 2: return pc?.game_wss_my;
    case 3: return pc?.game_wss_th;
    case 4: return pc?.game_wss_vn;
    case 5: return pc?.game_wss_tw;
    case 0:
    default: return pc?.game_wss;
  }
}

function isAllowedDgWs(value: unknown) {
  try {
    const text = String(value || "").trim().replace(/\/$/, "");
    if (!text) return "";
    const parsed = new URL(text);
    const allowed = parsed.protocol === "wss:" &&
      /(?:^|\.)(?:kindlestone\.com|taxyss\.com|ywjxi\.com)$/i.test(parsed.hostname);
    return allowed ? text : "";
  } catch {
    return "";
  }
}

function collectConfiguredWs(pc: any, jsonType: number, origin: string) {
  let originVerified: string | undefined;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === "new-dd-cn.20299999.com") originVerified = HAR_VERIFIED_DG_WS;
  } catch {}

  const ordered: unknown[] = [
    process.env.DG_WS_URL,
    originVerified,
    primaryWsForType(pc, jsonType),
    pc?.game_wss,
    pc?.game_wss_overseas,
    pc?.game_wss_tw,
    pc?.game_wss_my,
    pc?.game_wss_th,
    pc?.game_wss_vn,
    pc?.game_wss_cn,
    pc?.game_wss_line1,
    pc?.game_wss_line2,
    pc?.game_wss_line3,
    pc?.game_wss_line4,
  ];

  const seenObjects = new Set<any>();
  const walk = (value: any) => {
    if (value == null) return;
    if (typeof value === "string") {
      if (/^wss:\/\//i.test(value.trim())) ordered.push(value);
      return;
    }
    if (typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(pc);

  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === "new-dd-cn.20299999.com") ordered.push(HAR_VERIFIED_DG_WS);
  } catch {}

  ordered.push(HAR_VERIFIED_DG_WS, DEFAULT_DG_WS, LEGACY_OVERSEAS_DG_WS);

  const out: string[] = [];
  for (const value of ordered) {
    const valid = isAllowedDgWs(value);
    if (valid && !out.includes(valid)) out.push(valid);
  }
  return out;
}

function n(value: bigint | number | undefined | null) {
  if (typeof value === "bigint") return Number(value);
  const x = Number(value ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function readVarint(buf: Buffer, start: number) {
  let value = 0n, shift = 0n, offset = start;
  while (offset < buf.length) {
    const b = buf[offset++]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, offset };
    shift += 7n;
    if (shift > 70n) throw new Error("invalid varint");
  }
  throw new Error("truncated varint");
}

function readLength(buf: Buffer, offset: number) {
  const len = readVarint(buf, offset);
  const size = Number(len.value);
  const end = len.offset + size;
  if (!Number.isSafeInteger(size) || end > buf.length) throw new Error("invalid length");
  return { start: len.offset, end, offset: end };
}

function skipField(buf: Buffer, offset: number, wire: number) {
  if (wire === 0) return readVarint(buf, offset).offset;
  if (wire === 1) return Math.min(buf.length, offset + 8);
  if (wire === 2) return readLength(buf, offset).offset;
  if (wire === 5) return Math.min(buf.length, offset + 4);
  throw new Error(`unsupported wire ${wire}`);
}

function parseDealer(buf: Buffer): DgRawDealer {
  const out: DgRawDealer = {};
  let o = 0;
  while (o < buf.length) {
    const key = readVarint(buf, o); o = key.offset;
    const field = Number(key.value >> 3n), wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, o); o = v.offset;
      if (field === 1) out.id = n(v.value); else if (field === 5) out.gender = n(v.value); else if (field === 6) out.online = v.value !== 0n; else if (field === 7) out.tableId = n(v.value); else if (field === 8) out.state = n(v.value); else if (field === 9) out.type = n(v.value);
    } else if (wire === 2) {
      const s = readLength(buf, o); o = s.offset; const text = buf.subarray(s.start, s.end).toString("utf8");
      if (field === 2) out.name = text; else if (field === 3) out.no = text; else if (field === 4) out.photo = text;
    } else o = skipField(buf, o, wire);
  }
  return out;
}

function parseTable(buf: Buffer): DgRawTable {
  const out: DgRawTable = { tel: [], ext: [], roads: [] };
  let o = 0;
  while (o < buf.length) {
    const key = readVarint(buf, o); o = key.offset;
    const field = Number(key.value >> 3n), wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, o); o = v.offset;
      if (field === 1) out.tableId = n(v.value); else if (field === 2) out.shoeId = n(v.value); else if (field === 3) out.playId = n(v.value); else if (field === 4) out.state = n(v.value); else if (field === 5) out.countDown = n(v.value); else if (field === 15) out.totalAmount = n(v.value); else if (field === 16) out.onlineCount = n(v.value); else if (field === 18) out.gameId = n(v.value);
    } else if (wire === 2) {
      const s = readLength(buf, o); o = s.offset; const part = buf.subarray(s.start, s.end);
      if (field === 6) out.result = part.toString("utf8");
      else if (field === 7) out.poker = part.toString("utf8");
      else if (field === 8) out.tel!.push(part.toString("utf8"));
      else if (field === 9) out.ext!.push(part.toString("utf8"));
      else if (field === 10) out.roads!.push(part.toString("utf8"));
      else if (field === 11) out.gameNo = part.toString("utf8");
      else if (field === 12) out.fms = part.toString("utf8");
      else if (field === 13) out.tableName = part.toString("utf8");
      else if (field === 14) out.vipName = part.toString("utf8");
      else if (field === 17) out.dealer = parseDealer(part);
      else if (field === 19) out.anchor = parseDealer(part);
    } else o = skipField(buf, o, wire);
  }
  return out;
}

export function parsePublicBean(buf: Buffer): PublicBean {
  const out: PublicBean = { list: [], table: [], dList: [] };
  let o = 0;
  while (o < buf.length) {
    const key = readVarint(buf, o); o = key.offset;
    const field = Number(key.value >> 3n), wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, o); o = v.offset;
      if (field === 1) out.cmd = n(v.value); else if (field === 3) out.codeId = n(v.value); else if (field === 4) out.lobbyId = n(v.value); else if (field === 6) out.tableId = n(v.value); else if (field === 7) out.seat = n(v.value); else if (field === 8) out.mid = n(v.value); else if (field === 10) out.type = n(v.value);
    } else if (wire === 1 && field === 9) {
      if (o + 8 > buf.length) throw new Error("truncated double");
      out.dList!.push(buf.readDoubleLE(o)); o += 8;
    } else if (wire === 2) {
      const s = readLength(buf, o); o = s.offset; const part = buf.subarray(s.start, s.end);
      if (field === 2) out.token = part.toString("utf8");
      else if (field === 9) {
        if (part.length % 8) throw new Error("invalid packed doubles");
        for (let p = 0; p < part.length; p += 8) out.dList!.push(part.readDoubleLE(p));
      }
      else if (field === 5) out.gameNo = part.toString("utf8");
      else if (field === 11) out.userName = part.toString("utf8");
      else if (field === 12) out.list!.push(part.toString("utf8"));
      else if (field === 14) out.object = part.toString("utf8");
      else if (field === 17) out.table!.push(parseTable(part));
    } else o = skipField(buf, o, wire);
  }
  return out;
}

function varint(value: number | bigint) {
  let v = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.trunc(value)));
  const bytes: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; bytes.push(b); } while (v);
  return Buffer.from(bytes);
}
function fieldVarint(field: number, value: number | bigint) { return Buffer.concat([varint((field << 3) | 0), varint(value)]); }
function fieldString(field: number, value: string) { const b = Buffer.from(value, "utf8"); return Buffer.concat([varint((field << 3) | 2), varint(b.length), b]); }
function encodePublicBean(cmd: number, encryptedToken: string, extra: { lobbyId?: number; gameNo?: string; tableId?: number; seat?: number; mid?: number; type?: number; object?: string; list?: string[] } = {}) {
  const parts: Buffer[] = [fieldVarint(1, cmd), fieldString(2, encryptedToken)];
  if (extra.lobbyId != null) parts.push(fieldVarint(4, extra.lobbyId));
  if (extra.gameNo) parts.push(fieldString(5, extra.gameNo));
  if (extra.tableId != null) parts.push(fieldVarint(6, extra.tableId));
  if (extra.seat != null && extra.seat >= 0) parts.push(fieldVarint(7, extra.seat));
  if (extra.mid != null) parts.push(fieldVarint(8, extra.mid));
  if (extra.type != null) parts.push(fieldVarint(10, extra.type));
  if (extra.list) for (const value of extra.list) parts.push(fieldString(12, value));
  if (extra.object != null) parts.push(fieldString(14, extra.object));
  return Buffer.concat(parts);
}

function roadResult(raw: string): DgRoadResult | null {
  const parts = String(raw || "").split("#");
  const code = Number(parts[1] ?? parts[0]);
  if (!Number.isFinite(code) || code <= 0) return null;
  // DG 原生百家樂路紙代碼不是 %4 分組。
  // 原站 bundle 的判斷是：1~4=莊、5~8=閒、9~12=和；
  // 同一勝負區間內的不同值用來夾帶對子等附加標記。
  if (code >= 1 && code <= 4) return "莊";
  if (code >= 5 && code <= 8) return "閒";
  if (code >= 9 && code <= 12) return "和";
  return null;
}
function parseRoads(roads: string[] | undefined) {
  // DG PublicBean.Table.roads / cmd=1004 list is newest -> oldest.
  // The MT road engine expects chronological order (oldest -> newest), so
  // reverse the raw DG array BEFORE mapping winners. Do not mirror the UI.
  return [...(roads || [])].reverse().map(roadResult).filter((x): x is DgRoadResult => !!x);
}
function countResults(results: DgRoadResult[]) { let banker = 0, player = 0, tie = 0; for (const r of results) r === "莊" ? banker++ : r === "閒" ? player++ : tie++; return { banker, player, tie }; }
function tableSort(a: DgTableSnapshot, b: DgTableSnapshot) { const an = Number(a.apiId.replace(/\D/g, "")), bn = Number(b.apiId.replace(/\D/g, "")); return an - bn || a.apiId.localeCompare(b.apiId); }

class RawWsClient {
  private socket: TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private static readonly MAX_BUFFER = 8 * 1024 * 1024;
  private static readonly MAX_MESSAGE = 8 * 1024 * 1024;
  private closed = false;
  private closeReported = false;
  constructor(private url: string, private origin: string, private onBinary: (data: Buffer) => void, private onOpen: () => void, private onClose: (why: string) => void) {}
  connect() {
    const u = new URL(this.url); const host = u.hostname; const port = Number(u.port || 443); const path = `${u.pathname || "/"}${u.search}`;
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] }); this.socket = sock;
    sock.setKeepAlive(true, 15000);
    const timeout = setTimeout(() => { try { sock.destroy(new Error("DG WebSocket 連線逾時")); } catch {} }, 9000);
    sock.once("secureConnect", () => {
      const req = [
        `GET ${path} HTTP/1.1`, `Host: ${host}${port === 443 ? "" : `:${port}`}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", `Origin: ${this.origin}`,
        "Cache-Control: no-cache", "Accept-Language: zh-TW,zh;q=0.9", "Pragma: no-cache",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36", "", ""
      ].join("\r\n");
      sock.write(req);
    });
    sock.on("data", chunk => {
      if (this.buffer.length + chunk.length > RawWsClient.MAX_BUFFER) {
        sock.destroy(new Error("DG WebSocket buffer exceeded safe limit"));
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.handshakeDone) {
        const idx = this.buffer.indexOf("\r\n\r\n"); if (idx < 0) return;
        const header = this.buffer.subarray(0, idx).toString("utf8"); this.buffer = this.buffer.subarray(idx + 4);
        if (!/^HTTP\/1\.[01] 101\b/m.test(header)) { sock.destroy(new Error(`DG WebSocket 握手失敗：${header.split("\r\n")[0] || "unknown"}`)); return; }
        const accept = header.match(/^sec-websocket-accept:\s*(.+)$/im)?.[1]?.trim(); if (accept && accept !== expected) { sock.destroy(new Error("DG WebSocket 握手驗證失敗")); return; }
        clearTimeout(timeout); this.handshakeDone = true; this.onOpen();
      }
      if (this.handshakeDone) this.consumeFrames();
    });
    const reportClose = (why: string) => {
      if (this.closed || this.closeReported) return;
      this.closeReported = true;
      this.onClose(why);
    };
    sock.on("error", err => reportClose(err.message || "socket error"));
    sock.on("close", () => {
      clearTimeout(timeout);
      reportClose(this.handshakeDone ? "closed" : "DG WebSocket 握手提前關閉");
    });
  }
  private frame(opcode: number, payload: Buffer) {
    const mask = randomBytes(4); let head: Buffer;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length <= 0xffff) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i]! ^ mask[i % 4]!;
    return Buffer.concat([head, mask, body]);
  }
  sendBinary(payload: Buffer) {
    if (!this.socket || !this.handshakeDone || this.socket.destroyed) return false;
    try { this.socket.write(this.frame(2, payload)); return true; } catch { return false; }
  }
  private sendPong(payload: Buffer) { if (this.socket && this.handshakeDone && !this.socket.destroyed) this.socket.write(this.frame(10, payload)); }
  private consumeFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!; const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80); let len = b1 & 0x7f, pos = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); pos = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this.close(); return; } len = Number(big); pos = 10; }
      if (len > RawWsClient.MAX_MESSAGE) { this.abort("DG WebSocket frame exceeded safe limit"); return; }
      const maskBytes = masked ? 4 : 0; if (this.buffer.length < pos + maskBytes + len) return;
      let payload = Buffer.from(this.buffer.subarray(pos + maskBytes, pos + maskBytes + len));
      if (masked) { const m = this.buffer.subarray(pos, pos + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4]!; }
      this.buffer = this.buffer.subarray(pos + maskBytes + len);
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.sendPong(payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) {
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > RawWsClient.MAX_MESSAGE) { this.abort("DG fragmented message exceeded safe limit"); return; }
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments); const op = this.fragmentOpcode;
          this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0;
          if (op === 2) this.onBinary(full);
        }
        continue;
      }
      if (!fin) { this.fragmentOpcode = opcode; this.fragments = [payload]; this.fragmentBytes = payload.length; continue; }
      if (opcode === 2) this.onBinary(payload);
    }
  }
  abort(reason: string) {
    if (this.closed) return;
    try { this.socket?.destroy(new Error(reason)); } catch { try { this.socket?.destroy(); } catch {} }
  }
  close() {
    this.closed = true;
    try { this.socket?.end(this.frame(8, Buffer.alloc(0))); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
  }
}

export class DgRelay {
  private token: string;
  private origin: string;
  private originalOrigin: string;
  private originCandidates: string[] = [];
  private originCandidateIndex = 0;
  private wsUrl = DEFAULT_DG_WS;
  private wsCandidates: string[] = [DEFAULT_DG_WS];
  private wsCandidateIndex = 0;
  private wsFailuresThisCycle = 0;
  private wsLastError = "";
  private gameBasePath = "/ddnewpc";
  private launchUrl: string;
  private jsonType = 0;
  private ws: RawWsClient | null = null;
  private transportMode: "raw" | "bridge" = "raw";
  private foregroundBridgeActive = false;
  // DG's page opens more than one WebSocket (the supplied HAR contains two
  // simultaneous sockets). Every local proxy socket must receive the same
  // upstream pushes; keeping only one sink makes the last socket replace the
  // first and can leave the page repeatedly authenticating/subscribing while
  // the assistant appears connected but its feed stalls.
  private foregroundBridgeSinks = new Set<(data: Buffer) => void>();
  private bootstrapFrames = new Map<number, Buffer>();
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private clients = new Set<SseClient>();
  private map = new Map<number, DgTableSnapshot>();
  private status: RelayStatus = "idle";
  private statusMessage = "待命";
  private initialVideoRequested = new Set<number>();
  private firstTableLogged = false;
  private lastActivityAt = Date.now();
  private lastVendorPacketAt = Date.now();
  private lastSubscriptionRecoveryAt = 0;
  private feedStale = false;
  // DG may push cmd=1004 (full road list) before the initial table snapshot.
  // Keep that newest road list temporarily instead of dropping it; otherwise
  // the UI can be exactly one hand behind DG at startup.
  private pendingRoads = new Map<number, string[]>();
  private dailyPnl: DgDailyPnl | null = null;
  private pnlRequest: { day: string; at: number } | null = null;
  private lastPnlRequestAt = 0;
  createPnlRequest(): Buffer | null {
    const now = Date.now();
    // The floating assistant needs to follow a settled hand closely. This is
    // still one authenticated socket, but has a short read-only report cadence.
    if (this.stopped || this.status !== "connected" || now - this.lastPnlRequestAt < 2000) return null;
    if (this.pnlRequest && now - this.pnlRequest.at < 6000) return null;
    this.pnlRequest = { day: dgReportDay(now), at: now };
    this.lastPnlRequestAt = now;
    return encodePublicBean(13, this.authToken(13), { type: 1, object: "1", list: DG_PNL_REPORT_LIST });
  }
  private requestDailyPnl() {
    if (this.transportMode !== "raw" || !this.ws) return;
    const frame = this.createPnlRequest();
    if (frame) this.ws.sendBinary(frame);
  }
  constructor(public readonly sessionId: string, public readonly gameUrl: string) {
    this.token = extractToken(gameUrl);
    this.launchUrl = gameUrl;
    this.origin = (() => { try { return new URL(gameUrl).origin; } catch { return ""; } })();
    this.originalOrigin = this.origin;
    this.originCandidates = this.origin ? [this.origin] : [];
    try {
      const u = new URL(gameUrl);
      const m = u.pathname.match(/^(.*?\/ddnew(?:pc|wap))(?=\/|$)/i);
      if (m?.[1]) this.gameBasePath = m[1].replace(/\/$/, "");
    } catch {}
    if (!this.token) throw new Error("DG 授權網址缺少 token");
  }
  getStatus(): RelayStatus { return this.status; }
  isForegroundBridgeActive(): boolean {
    return this.foregroundBridgeActive && !this.stopped;
  }
  isReusable(): boolean {
    if (this.stopped) return false;
    // Foreground DG iframe owns the only vendor session. Never treat that
    // relay as dead just because bridge status is connecting/error — a new
    // start() would open a second WebSocket and kick the live page.
    if (this.foregroundBridgeActive) return true;
    return this.status === "idle" || this.status === "connecting" || this.status === "connected";
  }
  private touch() { this.lastActivityAt = Date.now(); }
  canCollect(now = Date.now(), maxIdleMs = 180000): boolean {
    return !this.foregroundBridgeActive && this.clients.size === 0 && now - this.lastActivityAt > maxIdleMs;
  }
  subscriberCount(): number { return this.clients.size; }
  async start() {
    if (this.stopped || this.foregroundBridgeActive) return;
    // Chromium is intentionally NOT used. A lightweight Node TLS/WebSocket
    // transport keeps the DG road feed real-time without spawning a browser
    // process per user/session. This materially reduces Render RAM/CPU pressure
    // and avoids Chromium sessions competing with the foreground DG game.
    this.transportMode = "raw";
    this.setStatus("connecting", "DG 即時牌路連線中...");

    try {
      const launch = await resolveDgLaunch(this.gameUrl);
      this.launchUrl = launch.launchUrl;
      this.origin = launch.origin;
      this.originCandidates = Array.from(new Set([launch.origin, this.originalOrigin].filter(Boolean)));
      this.originCandidateIndex = 0;
      this.gameBasePath = launch.basePath;
      this.token = launch.token;
      this.jsonType = launch.jsonType;
      this.log(`啟動頁已確認：type=${this.jsonType}｜origin=${this.origin}｜host=${new URL(this.launchUrl).hostname}`);
    } catch (error: any) {
      this.originCandidates = this.originalOrigin ? [this.originalOrigin] : (this.origin ? [this.origin] : []);
      this.originCandidateIndex = 0;
      this.log(`啟動頁解析未完成，依原始網址與 type=0 規則繼續：${error?.message || "unknown"}`);
      this.jsonType = 0;
    }

    try {
      const cfg = await fetch(`${this.origin}${this.gameBasePath}/game_settings.json?v=${Date.now()}`, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: this.launchUrl,
          "Accept-Language": "zh-TW,zh;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(7000),
      });
      if (!cfg.ok) throw new Error(`game_settings ${cfg.status}`);
      const json: any = await cfg.json();
      const pc = json?.pc_h5 || {};
      const validated = collectConfiguredWs(pc, this.jsonType, this.origin);
      if (!validated.length) throw new Error(`DG type=${this.jsonType} 沒有可用 WSS`);
      this.wsCandidates = validated;
      this.wsCandidateIndex = 0;
      this.wsFailuresThisCycle = 0;
      this.wsLastError = "";
      this.wsUrl = this.wsCandidates[0]!;
      this.log(`WSS 候選：type=${this.jsonType} → ${this.wsCandidates.map(x=>{try{return new URL(x).hostname}catch{return x}}).join(", ")}`);
    } catch (error: any) {
      this.wsCandidates = collectConfiguredWs({}, this.jsonType, this.origin);
      this.wsCandidateIndex = 0;
      this.wsFailuresThisCycle = 0;
      this.wsLastError = "";
      this.wsUrl = this.wsCandidates[0] || HAR_VERIFIED_DG_WS;
      this.log(`設定讀取失敗，改試備援線：${error?.message || "unknown"}`);
    }
    this.open();
  }
  subscribe(client: SseClient) {
    this.touch();
    this.clients.add(client);
    this.sendTo(client, "status", { status: this.status, message: this.statusMessage });
    this.sendTo(client, "tables", this.tables());
    this.sendTo(client, "pnl", this.dailyPnl?.day === dgReportDay() ? this.dailyPnl : null);
    return () => { this.clients.delete(client); this.touch(); };
  }
  private sendTo(client: SseClient, event: string, data: unknown) { try { client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
  private broadcast(event: string, data: unknown) { for (const c of this.clients) this.sendTo(c, event, data); }
  private setStatus(status: RelayStatus, message: string) { this.status = status; this.statusMessage = message; this.broadcast("status", { status, message }); }
  private event(message: string) { this.broadcast("event", { message }); }
  private log(message: string) {
    console.log(`[DG relay][${this.sessionId.slice(0, 8)}] ${message}`);
    this.event(`DG ${message}`);
  }
  private tables() { return [...this.map.values()].sort(tableSort); }
  private emitTables() { this.broadcast("tables", this.tables()); }
  private authToken(cmd: number) { return encryptDgToken(JSON.stringify({ cmd, token: this.token, time: Date.now() })); }
  private send(cmd: number, extra: Parameters<typeof encodePublicBean>[2] = {}) { this.ws?.sendBinary(encodePublicBean(cmd, this.authToken(cmd), extra)); }
  private open() {
    if (this.stopped || this.transportMode !== "raw") return;
    let endpointName = this.wsUrl; try { endpointName = new URL(this.wsUrl).hostname; } catch {}
    const activeOrigin = this.originCandidates[this.originCandidateIndex] || this.origin;
    this.origin = activeOrigin;
    this.setStatus("connecting", `連線中 ${endpointName}...`);
    this.log(`嘗試 WSS=${endpointName}｜Origin=${activeOrigin}`);
    const url = signedDgWsUrl(this.wsUrl, this.token);
    this.ws = new RawWsClient(url, this.origin, data => {
      this.handle(data);
      if (this.foregroundBridgeActive) {
        for (const sink of this.foregroundBridgeSinks) {
          try { sink(data); } catch {}
        }
      }
    }, () => {
      if (this.stopped || this.transportMode !== "raw" || this.foregroundBridgeActive) {
        this.log(`前景 DG 已接管，放棄背景 101 驗證｜${endpointName}`);
        try { this.ws?.abort("DG 前景已接管"); } catch {}
        this.ws = null;
        return;
      }
      this.wsLastError = "";
      this.setStatus("connecting", `已連上 ${endpointName}，正在驗證...`);
      this.log(`WebSocket 101：${endpointName}｜Origin=${activeOrigin}`);
      this.send(10086, { tableId: 1, type: 0, object: "PC" });
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = setTimeout(() => {
        if (this.stopped || this.status === "connected") return;
        this.event(`DG 驗證回應逾時：${endpointName}`);
        this.ws?.abort("DG 驗證回應逾時");
      }, 6500);
    }, why => {
      if (this.stopped || this.transportMode !== "raw") return;
      if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = null;
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer); this.keepaliveTimer = null;
      const reason = String(why || "closed");
      const wasConnected = this.status === "connected";
      this.wsLastError = reason;
      this.log(`線路失敗：${endpointName}｜Origin=${activeOrigin}｜${reason}`);
      if (wasConnected) {
        this.wsFailuresThisCycle = 0;
        this.setStatus("connecting", "DG 即時連線中斷，正在重新連線...");
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), 1500);
        return;
      }
      this.wsFailuresThisCycle += 1;
      const canFailover = /(?:HTTP\/1\.[01]\s+(?:400|401|403|404|429|500|502|503|504)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|連線逾時|handshake|握手|^closed$)/i.test(reason);
      if (canFailover && this.wsCandidates.length > 1 && this.wsFailuresThisCycle < this.wsCandidates.length) {
        this.wsCandidateIndex = (this.wsCandidateIndex + 1) % this.wsCandidates.length;
        this.wsUrl = this.wsCandidates[this.wsCandidateIndex]!;
        let host = this.wsUrl; try { host = new URL(this.wsUrl).hostname; } catch {}
        this.setStatus("connecting", `目前線路失敗，切換 ${host}...`);
        this.event(`DG 線路失敗：${reason}｜改試 ${host}`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), 450);
        return;
      }
      // Important: do not spin forever in "connecting". After every advertised
      // endpoint has been tried once, surface a real error so the browser can
      // request a fresh DG launch token and start a clean connection cycle.
      if (this.wsFailuresThisCycle >= this.wsCandidates.length) {
        const last = this.wsLastError;
        if (this.originCandidateIndex + 1 < this.originCandidates.length) {
          this.originCandidateIndex += 1;
          this.origin = this.originCandidates[this.originCandidateIndex]!;
          this.wsFailuresThisCycle = 0;
          this.wsCandidateIndex = 0;
          this.wsUrl = this.wsCandidates[0]!;
          this.setStatus("connecting", "DG Origin 切換後重新握手...");
          this.log(`WSS 全線未通，改試 Origin=${this.origin}`);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.open(), 350);
          return;
        }
        this.setStatus("error", `DG 所有線路握手失敗：${last}`);
        this.log(`所有 WSS / Origin 組合皆失敗：${last}`);
        this.wsFailuresThisCycle = 0;
        this.wsCandidateIndex = 0;
        this.originCandidateIndex = 0;
        this.origin = this.originCandidates[0] || this.origin;
        this.wsUrl = this.wsCandidates[0]!;
        return;
      }
      this.setStatus("error", `DG 連線失敗：${reason}`);
    });
    this.ws.connect();
  }
  private requestVideos() {
    if (this.transportMode !== "raw") return;
    const baccarat = this.tables().filter(t => /^BAC\d+/i.test(t.apiId) || /^TID\d+/i.test(t.apiId));
    baccarat.forEach((t, idx) => {
      const tableId = Number(t.tableBadge); if (!tableId || this.initialVideoRequested.has(tableId)) return;
      this.initialVideoRequested.add(tableId);
      setTimeout(() => { if (!this.stopped) this.send(29, { tableId, type: 1 }); }, 180 + idx * 90);
    });
  }
  private handle(data: Buffer) {
    this.touch();
    this.lastVendorPacketAt = Date.now();
    if (this.feedStale) {
      this.feedStale = false;
      this.setStatus("connected", "DG 即時資料已恢復");
      this.log("即時封包已恢復");
    }
    let bean: PublicBean; try { bean = parsePublicBean(data); } catch { return; }
    const cmd = n(bean.cmd);
    if (isDgPnlReply(bean)) {
      const pending = this.pnlRequest;
      this.pnlRequest = null;
      const report = pending ? parseDgDailyPnl(bean, pending.day) : null;
      if (report) { this.dailyPnl = report; this.broadcast("pnl", report); }
      return;
    }
    if (cmd === 10086 || cmd === 2 || cmd === 44) this.bootstrapFrames.set(cmd, Buffer.from(data));
    if (cmd === 10086) {
      if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = null;
      if (n(bean.codeId) !== 0) {
        const reason = `DG 驗證失敗 (${bean.codeId})`;
        if (this.transportMode === "bridge") {
          this.setStatus("error", reason);
          this.log(`Bridge｜${reason}`);
          return;
        }
        this.wsFailuresThisCycle += 1;
        if (this.wsCandidates.length > 1 && this.wsFailuresThisCycle < this.wsCandidates.length) {
          try { this.ws?.close(); } catch {}
          this.wsCandidateIndex = (this.wsCandidateIndex + 1) % this.wsCandidates.length;
          this.wsUrl = this.wsCandidates[this.wsCandidateIndex]!;
          let host = this.wsUrl; try { host = new URL(this.wsUrl).hostname; } catch {}
          this.setStatus("connecting", `驗證未通過，切換 ${host}...`);
          this.event(`${reason}｜改試 ${host}`);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.open(), 350);
          return;
        }
        if (this.originCandidateIndex + 1 < this.originCandidates.length) {
          try { this.ws?.close(); } catch {}
          this.originCandidateIndex += 1;
          this.origin = this.originCandidates[this.originCandidateIndex]!;
          this.wsFailuresThisCycle = 0;
          this.wsCandidateIndex = 0;
          this.wsUrl = this.wsCandidates[0] || HAR_VERIFIED_DG_WS;
          this.setStatus("connecting", "DG 驗證未通過，切換 Origin 重試...");
          this.log(`${reason}｜改試 Origin=${this.origin}`);
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.open(), 350);
          return;
        }
        this.setStatus("error", reason);
        this.log(`${reason}｜已嘗試全部 WSS / Origin 組合`);
        this.wsFailuresThisCycle = 0;
        this.wsCandidateIndex = 0;
        this.originCandidateIndex = 0;
        this.origin = this.originCandidates[0] || this.origin;
        this.wsUrl = this.wsCandidates[0] || HAR_VERIFIED_DG_WS;
        return;
      }
      this.wsFailuresThisCycle = 0;
      this.wsLastError = "";
      this.setStatus("connected", "已連線"); this.log(`驗證完成｜WSS=${(()=>{try{return new URL(this.wsUrl).hostname}catch{return this.wsUrl}})()}｜Origin=${this.origin}｜mode=${this.transportMode}`);
      if (this.transportMode !== "raw" || this.foregroundBridgeActive) {
        this.log("前景 DG 已接管，丟棄背景驗證連線");
        try { this.ws?.abort("DG 前景已接管"); } catch {}
        this.ws = null;
        return;
      }
      if (this.transportMode === "raw") {
        this.requestDailyPnl();
        this.send(45, { type: 1 }); this.send(2, { lobbyId: 5, type: 0 }); this.send(5011, { type: 0 });
        setTimeout(() => { if (!this.stopped) this.send(87, { type: 1 }); }, 80);
        setTimeout(() => { if (!this.stopped) this.send(24, { type: 2 }); }, 120);
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        // DG's captured native page sends cmd=99 every 3 seconds. A 20-second
        // interval can leave the TCP/WebSocket open while the vendor silently
        // stops live table pushes, producing a false "DG LIVE" stale screen.
        this.keepaliveTimer = setInterval(() => {
          if (this.stopped) return;
          this.send(99);
          this.requestDailyPnl();
          const now = Date.now();
          if (now - this.lastVendorPacketAt <= 9000 || now - this.lastSubscriptionRecoveryAt <= 9000) return;
          this.lastSubscriptionRecoveryAt = now;
          this.feedStale = true;
          this.setStatus("connecting", "DG 即時資料逾時，正在原連線恢復...");
          // Recover subscriptions on the SAME authenticated socket. Never send
          // cmd=10086 here and never create a second DG login/session.
          this.send(45, { type: 1 });
          this.send(2, { lobbyId: 5, type: 0 });
          this.send(5011, { type: 0 });
          this.send(87, { type: 1 });
          this.send(24, { type: 2 });
          this.log("即時封包逾時 9 秒，已在原連線重送牌路訂閱（未重新登入）");
        }, 3000);
      }
    }
    if (cmd === 29 && bean.tableId && bean.object && /^https?:\/\//i.test(bean.object)) {
      const prev = this.map.get(bean.tableId); if (prev) { this.map.set(bean.tableId, { ...prev, streamUrl: bean.object, lastUpdated: Date.now() }); this.emitTables(); }
    }
    if (cmd === 1004 && bean.tableId && bean.list?.length) {
      const tableId = n(bean.tableId);
      const fullRoads = [...bean.list];
      const prev = this.map.get(tableId);
      if (!prev) {
        // Chromium can receive the road push before cmd=2/cmd=44 creates the table.
        // Save it and merge it into the first snapshot instead of losing the newest hand.
        this.pendingRoads.set(tableId, fullRoads);
      } else {
        const results = parseRoads(fullRoads);
        const counts = countResults(results);
        this.map.set(tableId, { ...prev, results, ...counts, lastUpdated: Date.now(), lastResultKey: `${prev.shoe}:${prev.round}:${results.length}:${results.at(-1) || ""}` });
        this.pendingRoads.delete(tableId);
        this.emitTables();
        // A full road push follows a completed hand. Ask the already connected
        // DG session for the updated daily total immediately; the 2s gate above
        // prevents bursts when the lobby sends duplicate road packets.
        this.requestDailyPnl();
      }
    }
    if (bean.table?.length) {
      let changed = false;
      for (const raw of bean.table) {
        const tableId = n(raw.tableId); if (!tableId) continue;
        const prev = this.map.get(tableId);
        const fms = String(raw.fms ?? prev?.apiId ?? "").trim().toUpperCase();
        const gameId = raw.gameId != null ? n(raw.gameId) : undefined;
        if (!prev && gameId !== 1) continue;
        if (!prev && !fms) continue;
        const snapshotRoads = raw.roads?.length ? raw.roads : undefined;
        const queuedRoads = !prev ? this.pendingRoads.get(tableId) : undefined;
        // At initial connect, prefer cmd=1004 when it is at least as new as the
        // snapshot. This prevents counts/珠盤/大路/下三路 from starting one hand behind.
        const roads = queuedRoads && (!snapshotRoads || queuedRoads.length >= snapshotRoads.length)
          ? queuedRoads
          : snapshotRoads;
        const results = roads ? parseRoads(roads) : (prev?.results ?? []);
        const counts = countResults(results);
        const dealer = raw.dealer;
        const dealerPhoto = dealer?.photo ? `${this.origin}/vd/vd/image/Image/dealer/${String(dealer.photo).replace(/^\/+/, "")}` : prev?.dealerPhoto;
        const apiId = fms || prev?.apiId || `DG${tableId}`;
        const shoeNum = raw.shoeId != null ? n(raw.shoeId) : undefined;
        const roundNum = raw.playId != null ? n(raw.playId) : undefined;
        const next: DgTableSnapshot = {
          id: apiId, apiId, game: "百家樂", name: String(dealer?.name ?? prev?.name ?? "—"), players: raw.onlineCount != null ? String(n(raw.onlineCount)) : (prev?.players ?? "—"),
          countdown: raw.countDown != null ? n(raw.countDown) : prev?.countdown, countdownUpdatedAt: raw.countDown != null ? Date.now() : prev?.countdownUpdatedAt,
          roomId: String(raw.tableName ?? prev?.roomId ?? "—"), tableBadge: String(tableId), shoe: shoeNum != null && shoeNum > 0 ? String(shoeNum) : (prev?.shoe ?? "—"),
          round: roundNum ?? prev?.round ?? 0, ...counts, results, trend: prev?.trend ?? "", live: true, dealerPhoto, streamUrl: prev?.streamUrl,
          lastUpdated: Date.now(), lastResultKey: results.length ? `${shoeNum ?? prev?.shoe ?? "—"}:${roundNum ?? prev?.round ?? 0}:${results.length}:${results.at(-1)}` : prev?.lastResultKey,
          poker: raw.poker != null ? String(raw.poker) : prev?.poker,
        };
        this.map.set(tableId, next);
        if (!prev) this.pendingRoads.delete(tableId);
        changed = true;
      }
      if (changed) {
        this.emitTables();
        if (!this.firstTableLogged && this.map.size > 0) {
          this.firstTableLogged = true;
          this.log(`已同步真人桌：${this.map.size} 桌`);
        }
        if (cmd === 2 || cmd === 44) this.requestVideos();
      }
    }
  }
  matchesToken(token: string) {
    return !!token && token === this.token;
  }

  /**
   * Switch the existing relay object to browser-bridge mode without destroying
   * SSE subscribers or the last table snapshot. The real DG iframe becomes the
   * ONLY DG session; its already-received binary frames are mirrored back here
   * by the companion Chrome extension.
   */
  enterBridgeMode() {
    if (this.stopped) throw new Error("DG relay 已停止");
    // The real in-app DG page becomes the only vendor WebSocket owner. Its
    // received binary frames are mirrored back through /api/dg/proxy/frames.
    // Stop the background socket first so this transition never double-logins.
    this.foregroundBridgeActive = true;
    this.transportMode = "bridge";
    this.foregroundBridgeSinks.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer); this.keepaliveTimer = null;
    try { this.ws?.abort("DG 前景接管"); } catch {}
    this.ws = null;
    this.setStatus("connecting", "等待 DG 網頁即時封包...");
    this.log("Bridge｜背景 WebSocket 已停止，前景 DG 網頁接管唯一即時連線");
  }

  attachForegroundBridgeSink(sink: (data: Buffer) => void) {
    if (this.stopped || !this.foregroundBridgeActive) return () => {};
    this.foregroundBridgeSinks.add(sink);
    return () => { this.foregroundBridgeSinks.delete(sink); };
  }

  async forwardForegroundFrame(data: Buffer, localReply?: (data: Buffer) => void) {
    if (this.stopped || !this.foregroundBridgeActive || !data?.length || !this.ws) return false;
    try {
      const cmd = n(parsePublicBean(data).cmd);
      if (cmd === 10086 || cmd === 45 || cmd === 2 || cmd === 5011 || cmd === 87 || cmd === 24 || cmd === 99) {
        if (localReply) {
          const replay = cmd === 10086 ? [10086] : cmd === 2 ? [2, 44] : [];
          for (const responseCmd of replay) {
            const cached = this.bootstrapFrames.get(responseCmd);
            if (cached) { try { localReply(Buffer.from(cached)); } catch {} }
          }
        }
        this.touch();
        return true;
      }
    } catch {}
    return this.ws.sendBinary(data);
  }

  ingestBridgeFrame(data: Buffer) {
    if (this.stopped || !data?.length) return false;
    if (this.status !== "connected") this.setStatus("connected", "DG 網頁即時封包已接通");
    this.handle(data);
    return true;
  }

  bridgeSocketState(state: "open" | "close" | "error", pageUrl?: string) {
    if (this.stopped || !this.foregroundBridgeActive) return;
    if (pageUrl) {
      try {
        const u = new URL(pageUrl);
        this.launchUrl = u.toString();
      } catch {}
    }
    if (state === "open") {
      this.log("Bridge｜前景 DG 已接上既有輕量 WebSocket 單一 Session");
    } else {
      this.log(`Bridge｜前景 DG ${state === "close" ? "已離開" : "橋接發生錯誤"}`);
    }
  }

  async leaveBridgeMode() {
    if (this.stopped || !this.foregroundBridgeActive) return;
    this.foregroundBridgeActive = false;
    this.foregroundBridgeSinks.clear();
    this.transportMode = "raw";
    if (!this.map.size) this.setStatus("connecting", "正在恢復 DG 背景牌路...");
    this.log("Bridge｜已離開前景 DG，恢復背景 WebSocket");
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer); this.keepaliveTimer = null;
    this.ws?.close(); this.ws = null;
    this.foregroundBridgeActive = false;
    this.foregroundBridgeSinks.clear();
    this.bootstrapFrames.clear();
    this.clients.clear();
    this.map.clear();
    this.pendingRoads.clear();
    this.initialVideoRequested.clear();
    this.log("中繼已停止"); this.status = "closed"; this.statusMessage = "已停止";
  }
}

const relays = new Map<string, DgRelay>();
const relayStarts = new Map<string, Promise<DgRelay>>();

/**
 * Start is intentionally idempotent per tracker session.
 * React effects / recovery checks can race and call /api/dg/start more than once;
 * a second start must NEVER stop a relay that is already connecting/connected.
 * Manual reconnect first calls /api/dg/stop, which clears this slot explicitly.
 */
/** Create a relay object for foreground enter without opening a background WS.
 *  Opening WS here would share the new DGLI token with the iframe and kick DG. */
export function ensureDgRelayShell(sessionId: string, gameUrl: string): DgRelay {
  const existing = relays.get(sessionId);
  if (existing && !existing.stopped && existing.matchesToken(new URL(gameUrl).searchParams.get("token") || ""))
    return existing;
  if (existing) {
    try { existing.stop(); } catch {}
    relays.delete(sessionId);
  }
  relayStarts.delete(sessionId);
  const relay = new DgRelay(sessionId, gameUrl);
  relays.set(sessionId, relay);
  return relay;
}

export async function startDgRelay(sessionId: string, gameUrl: string): Promise<{relay:DgRelay;reused:boolean}> {
  const existing = relays.get(sessionId);
  if (existing?.isForegroundBridgeActive() || existing?.isReusable())
    return { relay: existing, reused: true };

  const inFlight = relayStarts.get(sessionId);
  if (inFlight) return { relay: await inFlight, reused: true };

  if (existing) {
    existing.stop();
    relays.delete(sessionId);
  }

  const relay = new DgRelay(sessionId, gameUrl);
  relays.set(sessionId, relay);
  let startPromise!: Promise<DgRelay>;
  startPromise = relay.start().then(() => relay).catch((error) => {
    if (relays.get(sessionId) === relay) relays.delete(sessionId);
    try { relay.stop(); } catch {}
    throw error;
  }).finally(() => {
    if (relayStarts.get(sessionId) === startPromise) relayStarts.delete(sessionId);
  });
  relayStarts.set(sessionId, startPromise);
  return { relay: await startPromise, reused: false };
}
export function getDgRelay(sessionId: string) { return relays.get(sessionId) || null; }
export function stopDgRelay(sessionId: string) {
  const r = relays.get(sessionId);
  if (r) r.stop();
  relays.delete(sessionId);
  relayStarts.delete(sessionId);
}

export function sweepIdleDgRelays(maxIdleMs = 180000) {
  const now = Date.now();
  let stopped = 0;
  for (const [sessionId, relay] of relays) {
    if (!relay.canCollect(now, maxIdleMs)) continue;
    try { relay.stop(); } catch {}
    relays.delete(sessionId);
    relayStarts.delete(sessionId);
    stopped += 1;
  }
  return { active: relays.size, stopped };
}

export function findDgRelayByToken(token: string) {
  const clean = String(token || "").trim();
  if (!clean) return null;
  for (const relay of relays.values()) if (relay.matchesToken(clean)) return relay;
  return null;
}
