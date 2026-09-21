import { dgReportDay, type DgDailyPnl } from "./dg-report";
export type DgRoadResult = "莊" | "閒" | "和";

export type DgTableData = {
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

type DgStatus = "idle" | "loading" | "connecting" | "connected" | "error" | "closed";

type DgCallbacks = {
  onTables: (tables: DgTableData[]) => void;
  onStatus?: (status: DgStatus, message?: string) => void;
  onEvent?: (message: string) => void;
  onPnl?: (report: DgDailyPnl | null) => void;
};

type DgController = { close: () => void };

let vendorPromise: Promise<void> | null = null;

function loadScript(src: string, flag: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.reject(new Error("DG 即時資料僅支援 Web"));
  const w = window as any;
  if (flag === "crypto" && w.CryptoJS) return Promise.resolve();
  if (flag === "protobuf" && w.protobuf) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-dg-vendor="${flag}"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`DG ${flag} 載入失敗`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.dgVendor = flag;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`DG ${flag} 載入失敗`));
    document.head.appendChild(script);
  });
}

async function ensureVendor() {
  if (vendorPromise) return vendorPromise;
  vendorPromise = (async () => {
    await loadScript("/dg-vendor/CryptoJS.js", "crypto");
    await loadScript("/dg-vendor/protobuf.js", "protobuf");
  })();
  return vendorPromise;
}


function numberOf(value: any) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return Number(value.toNumber());
  if (value && typeof value.low === "number") return Number(value.low >>> 0);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function baccaratResultFromRoad(raw: string): DgRoadResult | null {
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

function parseRoads(roads: any[]): DgRoadResult[] {
  // DG sends its road list newest -> oldest. All road builders in this app
  // consume chronological results (oldest -> newest), therefore normalize
  // the source sequence here before bead / Big Road / derived-road rebuilds.
  return [...(Array.isArray(roads) ? roads : [])].reverse().map(baccaratResultFromRoad).filter((x): x is DgRoadResult => !!x);
}

function countResults(results: DgRoadResult[]) {
  let banker = 0, player = 0, tie = 0;
  for (const r of results) {
    if (r === "莊") banker++;
    else if (r === "閒") player++;
    else tie++;
  }
  return { banker, player, tie };
}

function dgPhotoUrl(gameUrl: string, photo?: string) {
  if (!photo) return undefined;
  try {
    const origin = new URL(gameUrl).origin;
    return `${origin}/vd/vd/image/Image/dealer/${String(photo).replace(/^\/+/, "")}`;
  } catch {
    return undefined;
  }
}

function normalizeTable(raw: any, previous: DgTableData | undefined, gameUrl: string): DgTableData | null {
  const tableId = numberOf(raw?.tableId);
  const fms = String(raw?.fms ?? previous?.apiId ?? "").trim().toUpperCase();
  const gameId = numberOf(raw?.gameId);
  const isExisting = !!previous;
  if (!isExisting) {
    // DG's baccarat lobby contains both BAC*** and TID*** display codes.
    // gameId=1 is the authoritative baccarat discriminator in PublicBean.Table.
    if (gameId !== 1 || !fms) return null;
  }
  const roads = Array.isArray(raw?.roads) && raw.roads.length ? raw.roads : undefined;
  const results = roads ? parseRoads(roads) : (previous?.results ?? []);
  const counts = countResults(results);
  const dealer = raw?.dealer ?? {};
  const apiId = fms || previous?.apiId || `DG${tableId}`;
  const displayId = apiId;
  const round = numberOf(raw?.playId) || previous?.round || 0;
  const shoe = raw?.shoeId != null ? String(numberOf(raw.shoeId)) : (previous?.shoe ?? "—");
  const countdown = raw?.countDown != null ? numberOf(raw.countDown) : previous?.countdown;
  const tableName = String(raw?.tableName ?? previous?.roomId ?? "—");
  const dealerName = String(dealer?.name ?? previous?.name ?? "—");
  const dealerPhoto = dealer?.photo ? dgPhotoUrl(gameUrl, String(dealer.photo)) : previous?.dealerPhoto;
  const players = raw?.onlineCount != null ? String(numberOf(raw.onlineCount)) : (previous?.players ?? "—");
  const resultKey = results.length ? `${shoe}:${round}:${results.length}:${results[results.length - 1]}` : previous?.lastResultKey;
  return {
    id: displayId,
    apiId,
    game: "百家樂",
    name: dealerName,
    players,
    countdown,
    countdownUpdatedAt: raw?.countDown != null ? Date.now() : previous?.countdownUpdatedAt,
    roomId: tableName,
    tableBadge: tableId ? String(tableId) : previous?.tableBadge,
    shoe,
    round,
    banker: counts.banker,
    player: counts.player,
    tie: counts.tie,
    results,
    trend: previous?.trend ?? "",
    live: true,
    dealerPhoto,
    streamUrl: previous?.streamUrl,
    lastUpdated: Date.now(),
    lastResultKey: resultKey,
    poker: raw?.poker != null ? String(raw.poker) : previous?.poker,
  };
}

function sortDgTables(tables: DgTableData[]) {
  return [...tables].sort((a, b) => {
    const an = Number(String(a.apiId).replace(/\D/g, ""));
    const bn = Number(String(b.apiId).replace(/\D/g, ""));
    return an - bn || a.apiId.localeCompare(b.apiId);
  });
}

function base64ToBytes(base64: string) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Android app path: let the real DG page own the WebSocket inside a hidden
 * native WebView. That preserves DG's actual Origin, direct1 -> index redirect,
 * regional type selection, sign generation and command bootstrap. The native
 * wrapper only mirrors the already-received protobuf frames back here.
 */
async function connectDgNativeWebView(gameUrl: string, callbacks: DgCallbacks): Promise<DgController | null> {
  if (typeof window === "undefined") return null;
  const w = window as any;
  const native = w.NativeBridge;
  if (!native || typeof native.startDg !== "function" || typeof native.stopDg !== "function") return null;

  callbacks.onStatus?.("loading", "正在啟動 DG 原生連線");
  await ensureVendor();
  const protobuf = w.protobuf;
  const protoText = await fetch("/dg-vendor/PublicBeanProto.proto", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("DG Protobuf 定義載入失敗");
    return r.text();
  });
  const PublicBean = protobuf.parse(protoText).root.lookupType("PublicBean");
  const map = new Map<number, DgTableData>();
  let closed = false;
  let connected = false;
  let lastEmitAt = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 45) return;
    lastEmitAt = now;
    callbacks.onTables(sortDgTables(Array.from(map.values())));
  };

  const handlePacket = (decoded: any) => {
    const cmd = numberOf(decoded?.cmd);
    if (cmd === 10086) {
      const code = numberOf(decoded?.codeId);
      if (code === 0) {
        if (!connected) callbacks.onEvent?.("DG 原生驗證完成，正在同步真人桌");
        connected = true;
        callbacks.onStatus?.("connected", "DG 已連線");
      } else {
        callbacks.onStatus?.("error", `DG 驗證失敗 (${code})`);
      }
    }

    if (cmd === 1004 && decoded?.tableId && Array.isArray(decoded?.list) && decoded.list.length) {
      const id = numberOf(decoded.tableId);
      const previous = map.get(id);
      if (previous) {
        const next = normalizeTable({ tableId: id, roads: decoded.list }, previous, gameUrl);
        if (next) { map.set(id, next); emit(true); }
      }
    }

    if (cmd === 29 && decoded?.tableId && typeof decoded?.object === "string" && /^https?:\/\//i.test(decoded.object)) {
      const id = numberOf(decoded.tableId);
      const previous = map.get(id);
      if (previous) { map.set(id, { ...previous, streamUrl: decoded.object, lastUpdated: Date.now() }); emit(true); }
    }

    const incoming = Array.isArray(decoded?.table) ? decoded.table : [];
    if (incoming.length) {
      let changed = false;
      for (const raw of incoming) {
        const id = numberOf(raw?.tableId);
        if (!id) continue;
        const previous = map.get(id);
        const next = normalizeTable(raw, previous, gameUrl);
        if (!next) continue;
        map.set(id, next);
        changed = true;
      }
      if (changed) emit(cmd === 2 || cmd === 44);
    }
  };

  const previousPacket = w.__MT_DG_NATIVE_PACKET;
  const previousState = w.__MT_DG_NATIVE_STATE;

  const packetHandler = (base64: string) => {
    if (closed) return;
    try {
      const bytes = base64ToBytes(base64);
      const decoded = PublicBean.toObject(PublicBean.decode(bytes), { longs: Number, enums: String, defaults: false, arrays: true, objects: true });
      handlePacket(decoded);
    } catch (error: any) {
      callbacks.onEvent?.(`DG 原生封包解析略過：${error?.message || "unknown"}`);
    }
  };
  const stateHandler = (state: string, detail: string) => {
    if (closed) return;
    switch (String(state || "")) {
      case "page": callbacks.onStatus?.("loading", "DG 原生頁面載入中..."); break;
      case "inject":
      case "hook": callbacks.onStatus?.("connecting", "DG 原生通訊已載入"); break;
      case "socket_create": callbacks.onStatus?.("connecting", "DG 原生 WebSocket 連線中..."); break;
      case "open": callbacks.onStatus?.("connecting", "DG WebSocket 已建立，正在驗證"); break;
      case "close": if (!connected) callbacks.onStatus?.("error", `DG 原生連線關閉 ${detail || ""}`.trim()); break;
      case "error": callbacks.onStatus?.("error", "DG 原生 WebSocket 連線錯誤"); break;
      case "page_error": callbacks.onStatus?.("error", `DG 原生頁面錯誤：${detail || "unknown"}`); break;
      case "inject_error": callbacks.onEvent?.(`DG 注入失敗：${detail || "unknown"}`); break;
    }
  };

  w.__MT_DG_NATIVE_PACKET = packetHandler;
  w.__MT_DG_NATIVE_STATE = stateHandler;
  try {
    native.startDg(gameUrl);
  } catch (error: any) {
    if (w.__MT_DG_NATIVE_PACKET === packetHandler) w.__MT_DG_NATIVE_PACKET = previousPacket;
    if (w.__MT_DG_NATIVE_STATE === stateHandler) w.__MT_DG_NATIVE_STATE = previousState;
    throw new Error(error?.message || "DG 原生 WebView 啟動失敗");
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      try { native.stopDg(); } catch {}
      if (w.__MT_DG_NATIVE_PACKET === packetHandler) w.__MT_DG_NATIVE_PACKET = previousPacket;
      if (w.__MT_DG_NATIVE_STATE === stateHandler) w.__MT_DG_NATIVE_STATE = previousState;
      callbacks.onStatus?.("closed", "DG 已停止");
    },
  };
}


function jsonOf<T>(event: MessageEvent, fallback: T): T {
  try { return JSON.parse(String(event.data ?? "")) as T; } catch { return fallback; }
}

/**
 * Connection order:
 * 1) Android wrapper: real DG page in a hidden native WebView (preferred).
 * 2) Normal browser: server relay using the dynamically resolved DG launch URL.
 *
 * We intentionally no longer fall back to browser-direct WebSocket. A normal
 * browser cannot override the WebSocket Origin header, so that path can look
 * like an endless "connecting" state even though DG rejects it.
 */
async function connectDgServerRelay(gameUrl: string, sessionId: string, callbacks: DgCallbacks): Promise<DgController> {
  if (typeof window === "undefined" || typeof EventSource === "undefined") throw new Error("DG 即時連線目前僅支援網站/App版");
  if (!sessionId) throw new Error("登入工作階段已失效");

  const nativeController = await connectDgNativeWebView(gameUrl, callbacks);
  if (nativeController) return nativeController;

  let closed = false;
  let source: EventSource | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let connected = false;

  const detachRelayStream = () => {
    // Closing a React effect must only detach this browser's SSE listener.
    // It must NOT stop the server relay: dgGameUrl/status changes can remount
    // the effect while the same lightweight DG relay is still connecting or connected.
    try { source?.close(); } catch {}
    source = null;
  };

  callbacks.onStatus?.("loading", "正在確認 DG 啟動網址");
  const start = await fetch("/api/dg/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sessionId, gameUrl }),
  });
  let startData: any = null; try { startData = await start.json(); } catch {}
  if (!start.ok || !startData?.ok) {
    const message = String(startData?.error || `DG relay 啟動失敗 (${start.status})`);
    callbacks.onStatus?.("error", message);
    throw new Error(message);
  }

  source = new EventSource(`/api/dg/stream?sessionId=${encodeURIComponent(sessionId)}`);
  callbacks.onStatus?.("connecting", "DG 即時牌路連線中...");

  source.addEventListener("status", (raw: Event) => {
    if (closed) return;
    const data = jsonOf<{status?:DgStatus;message?:string}>(raw as MessageEvent, {});
    const status = data.status || "connecting";
    const message = data.message || "DG 連線中...";
    if (status === "connected") {
      connected = true;
      if (watchdog) clearTimeout(watchdog);
    }
    callbacks.onStatus?.(status, message);
  });
  source.addEventListener("tables", (raw: Event) => {
    if (closed) return;
    const next = jsonOf<DgTableData[]>(raw as MessageEvent, []);
    if (Array.isArray(next)) callbacks.onTables(next);
  });
  source.addEventListener("pnl", (raw: Event) => {
    if (closed) return;
    const report = jsonOf<DgDailyPnl | null>(raw as MessageEvent, null);
    callbacks.onPnl?.(report && typeof report.value === "number" && Number.isFinite(report.value) && report.day === dgReportDay() ? report : null);
  });
  source.addEventListener("event", (raw: Event) => {
    if (closed) return;
    const data = jsonOf<{message?:string}>(raw as MessageEvent, {});
    if (data.message) callbacks.onEvent?.(data.message);
  });
  source.onerror = () => {
    if (closed || connected) return;
    callbacks.onStatus?.("error", "DG 即時通道中斷");
  };
  watchdog = setTimeout(() => {
    if (!closed && !connected) {
      callbacks.onStatus?.("connecting", "DG 即時牌路仍在等待 WebSocket 101...");
      callbacks.onEvent?.("DG 後端正在使用輕量 WebSocket 連線；若仍無 101，請查看 Render Log 的 [DG relay] 訊息。");
    }
  }, 25000);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      detachRelayStream();
    },
  };
}

/**
 * Public connection entry.
 *
 * Web builds MUST use the same-origin backend relay. A normal browser always
 * sends the MT Assistant page as the WebSocket Origin and cannot spoof DG's
 * own page Origin, so browser-direct WSS is intentionally disabled.
 *
 * Android wrapper builds can still use the hidden native DG WebView path from
 * connectDgServerRelay(), because that WebView really loads the DG page and
 * therefore owns a legitimate DG Origin.
 */
export async function connectDgLive(gameUrl: string, sessionId: string, callbacks: DgCallbacks): Promise<DgController> {
  if (typeof window === "undefined") throw new Error("DG 即時連線目前僅支援網站/App版");
  if (!sessionId) throw new Error("登入工作階段已失效");
  callbacks.onEvent?.("DG 網頁版改走 Render 輕量 WebSocket 中繼；前端不另開第二條 DG session");
  return connectDgServerRelay(gameUrl, sessionId, callbacks);
}
