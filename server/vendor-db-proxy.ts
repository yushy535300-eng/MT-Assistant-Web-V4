import type { Express, Request, Response } from "express";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { dbExtractWsJson, getVendorRelay, stopOtherVendorRelays } from "./vendor-relay";
import { hasDbChromeHallHtml, readDbChromeResponse, rememberDbChromeResponse } from "./vendor-db-cache";
import { preferDbMobileUrl, fetchVendorLaunchUrl } from "./vendor-launch";

type ProxySession = {
  sessionId: string;
  origin: string;
  launchUrl: string;
  lastUsed: number;
  cookieJar: Map<string, string>;
  device: "Desktop" | "Mobile";
};

type RegisterOptions = {
  app: Express;
  server: HttpServer;
  hasActiveSession: (sessionId: string) => boolean;
};

const COOKIE_NAME = "mt_db_proxy_sid";
const proxySessions = new Map<string, ProxySession>();
const STATIC_ASSET_RE = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|wasm|map)$/i;
const MAX_PARALLEL_UPSTREAM = 2;
const ASSET_CACHE_LIMIT = 96;
const ASSET_CACHE_TTL_MS = 10 * 60 * 1000;
const assetCache = new Map<string, { status: number; contentType: string; body: Buffer; expires: number }>();
let upstreamInFlight = 0;
const upstreamWaiters: Array<() => void> = [];
let lastUpstreamAt = 0;
const MIN_UPSTREAM_GAP_MS = 80;

function logUpstreamFailure(target: URL, status: number, extra = "") {
  const bit = extra ? `｜${extra}` : "";
  console.warn(`[DB proxy] upstream ${status}｜${target.host}${target.pathname}${bit}`);
}

function acquireUpstreamSlot() {
  return new Promise<void>((resolve) => {
    const tryAcquire = () => {
      if (upstreamInFlight >= MAX_PARALLEL_UPSTREAM) {
        upstreamWaiters.push(tryAcquire);
        return;
      }
      upstreamInFlight++;
      resolve();
    };
    tryAcquire();
  });
}

function releaseUpstreamSlot() {
  upstreamInFlight = Math.max(0, upstreamInFlight - 1);
  const next = upstreamWaiters.shift();
  if (next) next();
}

function ensureProxySession(sessionId: string, origin: string, launchUrl: string, device: "Desktop" | "Mobile" = "Desktop") {
  const existing = proxySessions.get(sessionId);
  if (existing && existing.origin === origin) {
    existing.launchUrl = launchUrl;
    existing.lastUsed = Date.now();
    existing.device = device;
    return existing;
  }
  const session: ProxySession = { sessionId, origin, launchUrl, lastUsed: Date.now(), cookieJar: new Map(), device };
  proxySessions.set(sessionId, session);
  return session;
}

function parseCookie(header: string | undefined, name: string) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
  }
  return "";
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function wsAccept(key: string) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

export function resolveDbProxyPathname(pathname: string, device: "Desktop" | "Mobile" = "Desktop") {
  let p = String(pathname || "/");
  p = p.replace(/^\/egret\/api\/vendor\/db\/upstream(?=\/|$)/, "");
  p = p.replace(/^\/api\/vendor\/db\/upstream(?=\/|$)/, "");
  if (!p.startsWith("/")) p = "/" + p;
  if (device === "Mobile") return p === "/" ? "/" : p;
  if (p === "/") p = "/egret/hall";
  if (!p.startsWith("/egret")) p = "/egret" + p;
  return p;
}

export function sanitizeDbUpstreamSearch(search: string) {
  let raw = String(search || "");
  if (raw.startsWith("?")) raw = raw.slice(1);
  if (!raw) return "";
  const parts = raw.split("&").filter((part) => part && !/^mtProxySid=/i.test(part));
  return parts.length ? `?${parts.join("&")}` : "";
}

export function hasDbForegroundCookie(cookie: string | undefined, sessionId: string) {
  return !!sessionId && parseCookie(cookie, COOKIE_NAME) === sessionId;
}

export function endDbProxyForeground(sessionId: string) {
  if (sessionId) proxySessions.delete(sessionId);
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function restoreDbProxySession(sessionId: string, gameUrl: string) {
  let url: URL;
  try { url = new URL(gameUrl); } catch { return false; }
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) return false;
  const device = /\/h5\//i.test(url.pathname) && !/\/egret\//i.test(url.pathname) ? "Mobile" : "Desktop";
  ensureProxySession(sessionId, url.origin, url.toString(), device);
  return true;
}

function resolveDbProxyTarget(req: Request, origin: string, device: "Desktop" | "Mobile" = "Desktop") {
  let parsed: URL;
  try { parsed = new URL(req.originalUrl || req.url || "/", "http://localhost"); }
  catch { parsed = new URL("/", "http://localhost"); }
  const target = new URL(origin);
  target.pathname = resolveDbProxyPathname(parsed.pathname, device);
  target.search = sanitizeDbUpstreamSearch(parsed.search);
  target.hash = "";
  return target;
}

function injectDbHook(html: string, sessionId: string, upstreamOrigin: string, device: "Desktop" | "Mobile" = "Desktop") {
  const sid = JSON.stringify(sessionId);
  const origin = JSON.stringify(upstreamOrigin);
  const mobile = device === "Mobile";
  const hook = `<script>(function(){
const __sid=${sid},__origin=${origin},__mobile=${mobile ? "true" : "false"};
const NativeWS=window.WebSocket;
if(!NativeWS||window.__MT_DB_PROXY_WS__)return;
window.__MT_DB_PROXY_WS__=true;
try{navigator.serviceWorker&&navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})})}catch(e){}
try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error("disabled"))}}catch(e){}
const fixPath=(path)=>{try{let p=String(path||location.pathname);p=p.replace(/^\\/egret\\/api\\/vendor\\/db\\/upstream(?=\\/|$)/,"").replace(/^\\/api\\/vendor\\/db\\/upstream(?=\\/|$)/,"");if(!p.startsWith("/"))p="/"+p;if(__mobile)return p==="/"?"/":p;if(p==="/")p="/egret/hall";if(!p.startsWith("/egret"))p="/egret"+p;return p;}catch{return path}};
try{const next=fixPath(location.pathname);if(next!==location.pathname)history.replaceState(history.state,"",next+location.search+location.hash)}catch(e){}
const wrapHist=(fn)=>{return function(state,title,url){if(url!=null){try{const u=new URL(String(url),location.href);u.pathname=fixPath(u.pathname);url=u.pathname+u.search+u.hash}catch{}}return fn.call(this,state,title,url)}};
try{history.pushState=wrapHist(history.pushState.bind(history));history.replaceState=wrapHist(history.replaceState.bind(history))}catch(e){}
class MTDBWebSocket extends NativeWS{
  constructor(url,protocols){
    const raw=String(url||"");
    let next=raw;
    try{
      const u=new URL(raw,location.href);
      if(u.protocol==="ws:"||u.protocol==="wss:"){
        next=location.origin+"/api/vendor/db/ws?sessionId="+encodeURIComponent(__sid)+"&target="+encodeURIComponent(u.toString());
      }
    }catch{}
    if(arguments.length>1)super(next,protocols);else super(next);
  }
}
for(const k of ["CONNECTING","OPEN","CLOSING","CLOSED"])try{Object.defineProperty(MTDBWebSocket,k,{value:NativeWS[k]})}catch{}
window.WebSocket=MTDBWebSocket;
const mapHttp=(value)=>{try{const raw=String(value||"");if(!(raw.startsWith("http://")||raw.startsWith("https://")))return value;const u=new URL(raw);return u.origin===__origin?(u.pathname+u.search+u.hash):value;}catch{return value;}};
const nativeFetch=window.fetch;if(nativeFetch){window.fetch=function(input,init){if(typeof input==="string"||input instanceof URL)return nativeFetch.call(this,mapHttp(String(input)),init);return nativeFetch.call(this,input,init);};}
const xhrOpen=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;if(xhrOpen){XMLHttpRequest.prototype.open=function(method,url){const args=Array.from(arguments);args[1]=mapHttp(url);return xhrOpen.apply(this,args);};}
})();</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (m) => m + (mobile ? `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}canvas,video{max-width:100%;height:auto}</style>` : "") + hook);
  return hook + html;
}

function copyUpstreamHeaders(req: Request, target: URL, cookieHeader: string, device: "Desktop" | "Mobile" = "Desktop") {
  const headers = new Headers();
  const pass = ["accept", "accept-language", "cache-control", "pragma", "range", "if-none-match", "if-modified-since", "content-type", "user-agent"];
  for (const key of pass) {
    const v = req.headers[key];
    if (typeof v === "string" && v) headers.set(key, v);
  }
  headers.set("origin", target.origin);
  const referer = typeof req.headers.referer === "string" ? req.headers.referer : "";
  const fallbackPath = device === "Mobile" ? "/" : "/egret/hall";
  if (referer) {
    try {
      const local = new URL(referer);
      const next = new URL(target.origin);
      next.pathname = resolveDbProxyPathname(local.pathname, device);
      next.search = sanitizeDbUpstreamSearch(local.search);
      headers.set("referer", next.toString());
    } catch {
      headers.set("referer", `${target.origin}${fallbackPath}`);
    }
  } else {
    headers.set("referer", `${target.origin}${fallbackPath}`);
  }
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (device === "Mobile") {
    headers.set("user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  }
  return headers;
}

function cookieHeaderFromJar(session: ProxySession) {
  if (!session.cookieJar.size) return "";
  return [...session.cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rememberUpstreamCookies(session: ProxySession, upstream: globalThis.Response) {
  const anyHeaders = upstream.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof anyHeaders.getSetCookie === "function"
    ? anyHeaders.getSetCookie()
    : (upstream.headers.get("set-cookie") ? [String(upstream.headers.get("set-cookie"))] : []);
  for (const line of lines) {
    const nv = String(line || "").split(";")[0] || "";
    const i = nv.indexOf("=");
    if (i <= 0) continue;
    const name = nv.slice(0, i).trim();
    const value = nv.slice(i + 1).trim();
    if (!name || name === COOKIE_NAME) continue;
    if (!value || /(?:^|;)\s*max-age=0\b/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) session.cookieJar.delete(name);
    else session.cookieJar.set(name, value);
  }
}

function isCacheableAsset(method: string, target: URL, contentType: string) {
  if (method !== "GET") return false;
  if (/\/api\//i.test(target.pathname)) return false;
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return false;
  return STATIC_ASSET_RE.test(target.pathname);
}

function assetCacheKey(target: URL) {
  return target.origin + target.pathname + target.search;
}

function readAssetCache(target: URL) {
  const key = assetCacheKey(target);
  const hit = assetCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    assetCache.delete(key);
    return null;
  }
  assetCache.delete(key);
  assetCache.set(key, hit);
  return hit;
}

function writeAssetCache(target: URL, status: number, contentType: string, body: Buffer) {
  if (status !== 200 || body.length > 2 * 1024 * 1024) return;
  const key = assetCacheKey(target);
  assetCache.set(key, { status, contentType, body, expires: Date.now() + ASSET_CACHE_TTL_MS });
  while (assetCache.size > ASSET_CACHE_LIMIT) {
    const oldest = assetCache.keys().next().value;
    if (!oldest) break;
    assetCache.delete(oldest);
  }
}

function dbWafHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#05070a;color:#f0a36b;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center;padding:24px"><div style="font-size:22px;letter-spacing:.08em">官方暫時限流</div><p style="color:#8fb7c4;font-size:14px;line-height:1.6">請按「回牌路」等到主頁桌台還在，再進桌。不要連點。</p></div></body></html>`;
}

function sendCachedUpstream(res: Response, session: ProxySession, target: URL, cached: { status: number; contentType: string; body: Buffer }) {
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(cached.contentType) || /\/egret\/hall|\/h5\/?$/i.test(target.pathname);
  res.status(cached.status);
  if (isHtml) {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(injectDbHook(cached.body.toString("utf8"), session.sessionId, session.origin, session.device));
    return;
  }
  if (cached.contentType) res.setHeader("Content-Type", cached.contentType);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.end(cached.body);
}

function forwardResponseHeaders(upstream: globalThis.Response, res: Response, rewritten: boolean) {
  const blocked = new Set([
    "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "set-cookie",
    "content-security-policy", "content-security-policy-report-only", "x-frame-options", "cross-origin-opener-policy",
    "cross-origin-embedder-policy", "cross-origin-resource-policy",
  ]);
  upstream.headers.forEach((value, key) => {
    if (blocked.has(key.toLowerCase())) return;
    try { res.setHeader(key, value); } catch {}
  });
  if (rewritten) res.setHeader("Cache-Control", "no-store");
}

function sessionFromRequest(req: Request) {
  const sid = parseCookie(req.headers.cookie, COOKIE_NAME) || String(req.query?.mtProxySid || "");
  if (!sid) return null;
  const session = proxySessions.get(sid);
  if (!session) return null;
  session.lastUsed = Date.now();
  return session;
}

function encodeServerWsFrame(opcode: number, payload: Buffer) {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | (opcode & 0x0f), len]);
  else if (len <= 0xffff) {
    head = Buffer.alloc(4); head[0] = 0x80 | (opcode & 0x0f); head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x80 | (opcode & 0x0f); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class ClientFrameTap {
  private buffer = Buffer.alloc(0);
  constructor(private onText: (text: string) => void, private onRaw: (opcode: number, payload: Buffer) => void) {}
  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      const opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, pos = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); pos = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2)); pos = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < pos + maskBytes + len) return;
      let payload = Buffer.from(this.buffer.subarray(pos + maskBytes, pos + maskBytes + len));
      if (masked) {
        const mask = this.buffer.subarray(pos, pos + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
      }
      this.buffer = this.buffer.subarray(pos + maskBytes + len);
      if (opcode === 1) this.onText(payload.toString("utf8"));
      this.onRaw(opcode, payload);
    }
  }
}

export function registerDbGameProxy(options: RegisterOptions) {
  const { app, server, hasActiveSession } = options;

  const proxyHandler = async (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).send("DB proxy session expired");
    const target = resolveDbProxyTarget(req, session.origin, session.device);
    if (req.method === "GET") {
      const chromeHit = readDbChromeResponse(target);
      if (chromeHit) {
        sendCachedUpstream(res, session, target, chromeHit);
        return;
      }
    }
    const cached = req.method === "GET" ? readAssetCache(target) : null;
    if (cached) {
      sendCachedUpstream(res, session, target, cached);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const viaChrome = await getVendorRelay(session.sessionId, "DB")?.fetchViaChrome(target.toString());
      if (viaChrome?.body?.length) {
        rememberDbChromeResponse(target.toString(), viaChrome.status, viaChrome.contentType, viaChrome.body);
        writeAssetCache(target, viaChrome.status, viaChrome.contentType, viaChrome.body);
        sendCachedUpstream(res, session, target, viaChrome);
        return;
      }
      const relay = getVendorRelay(session.sessionId, "DB");
      if (relay?.isDbRateLimited()) {
        logUpstreamFailure(target, 504, "skip-node-during-waf");
        res.status(504).end();
        return;
      }
    }
    await acquireUpstreamSlot();
    try {
      const gap = MIN_UPSTREAM_GAP_MS - (Date.now() - lastUpstreamAt);
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      lastUpstreamAt = Date.now();
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers: copyUpstreamHeaders(req, target, cookieHeaderFromJar(session), session.device),
        redirect: "manual",
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (req.body != null && /application\/json/.test(ct)) init.body = JSON.stringify(req.body);
        else { init.body = req as any; init.duplex = "half"; }
      }
      let upstream = await fetch(target, init as any);
      rememberUpstreamCookies(session, upstream);
      const location = upstream.headers.get("location");
      if (location && upstream.status >= 300 && upstream.status < 400) {
        const next = new URL(location, target);
        if (next.origin === session.origin) {
          res.status(upstream.status).setHeader("Location", resolveDbProxyPathname(next.pathname, session.device) + sanitizeDbUpstreamSearch(next.search)).end();
          return;
        }
        res.status(upstream.status).setHeader("Location", next.toString()).end();
        return;
      }
      const contentType = upstream.headers.get("content-type") || "";
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
      if (upstream.status >= 400) {
        const fallback = readDbChromeResponse(target);
        if (fallback) {
          sendCachedUpstream(res, session, target, fallback);
          return;
        }
        if (!isHtml) logUpstreamFailure(target, upstream.status, `type=${contentType.slice(0, 40)}`);
      }
      res.status(upstream.status);
      forwardResponseHeaders(upstream, res, isHtml);
      if (req.method === "HEAD" || upstream.status === 204 || upstream.status === 304 || !upstream.body) return res.end();
      if (isHtml) {
        const html = await upstream.text();
        if (upstream.status >= 400) {
          const fallbackHtml = readDbChromeResponse(target);
          if (fallbackHtml) {
            sendCachedUpstream(res, session, target, fallbackHtml);
            return;
          }
          const rule = html.match(/Denied by ([a-z0-9_]+)/i)?.[1] || "";
          const requestId = html.match(/RequestID:\s*([a-z0-9]+)/i)?.[1] || "";
          logUpstreamFailure(target, upstream.status, [rule && `rule=${rule}`, requestId && `rid=${requestId}`].filter(Boolean).join("｜"));
          getVendorRelay(session.sessionId, "DB")?.noteDbUpstreamWaf();
          res.status(200).type("html").send(dbWafHtml());
          return;
        }
        res.type("html").send(injectDbHook(html, session.sessionId, session.origin, session.device));
        return;
      }
      if (isCacheableAsset(req.method, target, contentType)) {
        const body = Buffer.from(await upstream.arrayBuffer());
        writeAssetCache(target, upstream.status, contentType, body);
        return res.end(body);
      }
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (error: any) {
      console.error(`[DB proxy] HTTP failed｜${req.method} ${target.host}${target.pathname}｜${error?.message || error}`);
      if (!res.headersSent) res.status(502).send("DB proxy upstream failed");
      else res.end();
    } finally {
      releaseUpstreamSlot();
    }
  };

  app.use("/egret", proxyHandler);
  app.use("/h5", proxyHandler);
  app.use("/api/vendor/db/upstream", proxyHandler);

  app.post("/api/vendor/db/enter", async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    const device = String(req.body?.device || "") === "Mobile" ? "Mobile" : "Desktop";
    if (!sessionId || !hasActiveSession(sessionId)) return res.status(401).json({ ok: false, error: "session_invalid" });
    const relay = getVendorRelay(sessionId, "DB");
    if (!relay) return res.status(404).json({ ok: false, error: "relay_not_found" });
    const origin = (() => { try { return new URL(relay.gameUrl).origin; } catch { return ""; } })();
    if (relay.isDbRateLimited() && !hasDbChromeHallHtml(origin) && !relay.tableCount()) {
      return res.status(429).json({ ok: false, error: "DB 官方限流中，請稍後再進桌" });
    }
    await stopOtherVendorRelays(sessionId, "DB");
    await relay.pauseTransport();
    let launchUrl = relay.gameUrl;
    if (relay.launchAuth) {
      try {
        launchUrl = await fetchVendorLaunchUrl({ ...relay.launchAuth, kind: "DB", device });
      } catch (error: any) {
        console.warn(`[DB proxy] enter launch failed｜${error?.message || error}`);
        if (device === "Mobile") launchUrl = preferDbMobileUrl(relay.gameUrl);
      }
    } else if (device === "Mobile") {
      launchUrl = preferDbMobileUrl(relay.gameUrl);
    }
    if (device === "Mobile") launchUrl = preferDbMobileUrl(launchUrl);
    else if (!hasDbChromeHallHtml((() => { try { return new URL(launchUrl).origin; } catch { return ""; } })())) {
      return res.status(429).json({ ok: false, error: "請先等主頁 DB 桌台出現，再進桌" });
    }
    let url: URL;
    try { url = new URL(launchUrl); } catch { return res.status(400).json({ ok: false, error: "invalid_game_url" }); }
    if (url.protocol !== "https:" || isPrivateHost(url.hostname)) return res.status(400).json({ ok: false, error: "invalid_game_url" });
    ensureProxySession(sessionId, url.origin, url.toString(), device);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    const joined = url.search ? `${url.search}&mtProxySid=${encodeURIComponent(sessionId)}` : `?mtProxySid=${encodeURIComponent(sessionId)}`;
    const iframePath = `/api/vendor/db/upstream${resolveDbProxyPathname(url.pathname, device)}`;
    console.log(`[DB proxy] enter｜device=${device}｜host=${url.host}｜path=${url.pathname}`);
    return res.json({ ok: true, url: iframePath + joined + (url.hash || "") });
  });

  app.post("/api/vendor/db/leave", async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) return res.status(400).json({ ok: false });
    res.setHeader("Set-Cookie", endDbProxyForeground(sessionId));
    console.log(`[DB proxy] leave｜session=${sessionId.slice(0, 8)}`);
    const relay = getVendorRelay(sessionId, "DB");
    try { await relay?.resumeTransport(); } catch (error: any) { console.warn(`[DB proxy] resume failed｜${error?.message || error}`); }
    return res.json({ ok: true });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "", "http://localhost");
      if (u.pathname !== "/api/vendor/db/ws") return;
      handleDbWsUpgrade(req, socket as Socket, head, options);
    } catch { try { socket.destroy(); } catch {} }
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, item] of proxySessions) if (now - item.lastUsed > 6 * 60 * 60 * 1000) proxySessions.delete(sid);
  }, 30 * 60 * 1000);
  timer.unref?.();
}

function handleDbWsUpgrade(req: IncomingMessage, client: Socket, head: Buffer, options: RegisterOptions) {
  let parsed: URL;
  try { parsed = new URL(req.url || "", "http://localhost"); } catch { client.destroy(); return; }
  const sessionId = parsed.searchParams.get("sessionId") || "";
  const targetRaw = parsed.searchParams.get("target") || "";
  if (!sessionId || !options.hasActiveSession(sessionId)) { client.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const proxySession = proxySessions.get(sessionId);
  const relay = getVendorRelay(sessionId, "DB");
  if (!proxySession || !relay) { client.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  let target: URL | null = null;
  try { target = targetRaw ? new URL(targetRaw) : null; } catch {}
  if (!target || (target.protocol !== "wss:" && target.protocol !== "ws:") || isPrivateHost(target.hostname)) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const browserKey = String(req.headers["sec-websocket-key"] || "");
  if (!browserKey) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const proto = String(req.headers["sec-websocket-protocol"] || "").split(",")[0]?.trim();
  const upstreamHeaders: Record<string, string> = {
    Origin: proxySession.origin,
    "User-Agent": String(req.headers["user-agent"] || ""),
  };
  const jarCookie = cookieHeaderFromJar(proxySession);
  if (jarCookie) upstreamHeaders.Cookie = jarCookie;
  if (proto) upstreamHeaders["Sec-WebSocket-Protocol"] = proto;
  console.log(`[DB proxy] WS ${target.hostname}`);
  const upstream = proto
    ? new WebSocket(target.toString(), proto, { headers: upstreamHeaders } as any)
    : new WebSocket(target.toString(), { headers: upstreamHeaders } as any);
  try { (upstream as any).binaryType = "arraybuffer"; } catch {}

  const toBuffer = (data: any) => {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(String(data));
  };

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    try { upstream.close(); } catch {}
    try { client.destroy(); } catch {}
  };

  const ingestBuf = (buf: Buffer) => {
    const obj = dbExtractWsJson(buf, true);
    if (obj) relay.ingest(obj);
  };

  upstream.addEventListener("open", () => {
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${wsAccept(browserKey)}`,
    ];
    if (proto) lines.push(`Sec-WebSocket-Protocol: ${proto}`);
    lines.push("\r\n");
    client.write(lines.join("\r\n"));
    if (head?.length) client.emit("data", head);
  });
  upstream.addEventListener("message", (event) => {
    try {
      const data = event.data;
      if (typeof data === "string") {
        const obj = dbExtractWsJson(data, true);
        if (obj) relay.ingest(obj);
        client.write(encodeServerWsFrame(1, Buffer.from(data)));
        return;
      }
      const buf = toBuffer(data);
      ingestBuf(buf);
      client.write(encodeServerWsFrame(2, buf));
    } catch { finish(); }
  });
  upstream.addEventListener("close", finish);
  upstream.addEventListener("error", finish);

  const tap = new ClientFrameTap(
    (text) => {
      try { upstream.send(text); } catch { finish(); }
    },
    (opcode, payload) => {
      if (opcode === 1) return;
      if (opcode === 8) finish();
      else if (opcode === 9) {
        try { client.write(encodeServerWsFrame(10, payload)); } catch { finish(); }
        try { (upstream as any).ping?.(payload); } catch {}
      } else if (opcode === 10) return;
      else try { upstream.send(payload); } catch { finish(); }
    },
  );
  client.on("data", (chunk) => tap.push(Buffer.from(chunk)));
  client.on("error", finish);
}
