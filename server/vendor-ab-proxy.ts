import type { Express, Request, Response } from "express";
import http, { type Server as HttpServer, type IncomingMessage } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { VendorKind } from "./vendor-relay";
import { getVendorRelay, setAbGameForeground, stopOtherVendorRelays } from "./vendor-relay";
import { fetchVendorLaunchUrl, vendorLaunchIsReady } from "./vendor-launch";

type ProxySession = {
  sessionId: string;
  origin: string;
  launchUrl: string;
  lastUsed: number;
};

type RegisterOptions = {
  app: Express;
  server: HttpServer;
  hasActiveSession: (sessionId: string) => boolean;
};

const COOKIE_NAME = "mt_ab_proxy_sid";
const AB_DEFAULT_ORIGIN = "https://www.ab8888.games:8888";
const proxySessions = new Map<string, ProxySession>();

export function hasAbForegroundCookie(cookie: string | undefined, sessionId: string) {
  return !!sessionId && parseCookie(cookie, COOKIE_NAME) === sessionId;
}

export function endAbProxyForeground(sessionId: string) {
  if (sessionId) proxySessions.delete(sessionId);
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function restoreAbProxySession(sessionId: string, gameUrl = AB_DEFAULT_ORIGIN) {
  let url: URL;
  try { url = new URL(gameUrl); } catch {
    try { url = new URL(AB_DEFAULT_ORIGIN); } catch { return false; }
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || isPrivateHost(url.hostname)) return false;
  proxySessions.set(sessionId, { sessionId, origin: url.origin, launchUrl: url.toString(), lastUsed: Date.now() });
  return true;
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

function abIframeUrl(sessionId: string, launchUrl: string, device: "Desktop" | "Mobile") {
  const url = new URL(launchUrl);
  const hallHash = device === "Mobile" ? (url.hash || "") : (url.hash || "#/HOTGAME_HALL");
  const joined = url.search ? `${url.search}&mtProxySid=${encodeURIComponent(sessionId)}` : `?mtProxySid=${encodeURIComponent(sessionId)}`;
  return "/api/vendor/ab/upstream" + url.pathname + joined + hallHash;
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function wsAccept(key: string) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function injectAbHook(html: string, sessionId: string, upstreamOrigin: string) {
  const sid = JSON.stringify(sessionId);
  const origin = JSON.stringify(upstreamOrigin);
  const hook = `<script>(function(){
const __sid=${sid},__origin=${origin};
const NativeWS=window.WebSocket;
if(!NativeWS||window.__MT_AB_PROXY_WS__)return;
window.__MT_AB_PROXY_WS__=true;
try{navigator.serviceWorker&&navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})})}catch(e){}
try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error("disabled"))}}catch(e){}
try{const u=new URL(location.href);const vendorSid=u.searchParams.get("sessionId");if(vendorSid)localStorage.setItem("sessionId",vendorSid)}catch(e){}
class MTABWebSocket extends NativeWS{
  constructor(url,protocols){
    const raw=String(url||"");
    let next=raw;
    try{
      const u=new URL(raw,location.href);
      if(u.protocol==="ws:"||u.protocol==="wss:"){
        next=location.origin+"/api/vendor/ab/ws?sessionId="+encodeURIComponent(__sid)+"&target="+encodeURIComponent(u.toString());
      }
    }catch{}
    if(arguments.length>1)super(next,protocols);else super(next);
  }
}
for(const k of ["CONNECTING","OPEN","CLOSING","CLOSED"])try{Object.defineProperty(MTABWebSocket,k,{value:NativeWS[k]})}catch{}
window.WebSocket=MTABWebSocket;
const mapHttp=(value)=>{try{const raw=String(value||"");if(!(raw.startsWith("http://")||raw.startsWith("https://")))return value;const u=new URL(raw,location.href);if(u.origin===__origin)return"/api/vendor/ab/upstream"+u.pathname+u.search+u.hash;if(/\\/api-gw\\//.test(u.pathname)&&u.protocol==="https:")return"/api/vendor/ab/apigw?target="+encodeURIComponent(u.toString());return value;}catch{return value;}};
const tapBetLog=(json)=>{try{if(!json||typeof json!=="object")return;if(!json.data||!Array.isArray(json.data.C))return;nativeFetch("/api/vendor/ingest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:__sid,kind:"AB",messages:[json]})})}catch(e){}};
const nativeFetch=window.fetch;
if(nativeFetch){window.fetch=function(input,init){const url=typeof input==="string"||input instanceof URL?mapHttp(String(input)):input;const p=nativeFetch.call(this,url,init);try{p.then(function(r){const raw=typeof input==="string"?input:(input&&input.url)||"";if(!/betLog\\/records/i.test(String(raw)+String(url)))return;r.clone().json().then(tapBetLog).catch(function(){})})}catch(e){}return p;};}
const xhrOpen=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;if(xhrOpen){XMLHttpRequest.prototype.open=function(method,url){const args=Array.from(arguments);args[1]=mapHttp(url);return xhrOpen.apply(this,args);};}
const xhrSend=window.XMLHttpRequest&&XMLHttpRequest.prototype.send;if(xhrSend){XMLHttpRequest.prototype.send=function(){try{this.addEventListener("load",function(){try{if(!/betLog\\/records/i.test(String(this.responseURL||"")))return;tapBetLog(JSON.parse(this.responseText))}catch(e){}})}catch(e){}return xhrSend.apply(this,arguments)};}
})();</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (m) => m + hook);
  return hook + html;
}

function copyUpstreamHeaders(req: Request, origin: string) {
  const headers = new Headers();
  const pass = ["accept", "accept-language", "cache-control", "pragma", "range", "if-none-match", "if-modified-since", "content-type", "user-agent", "sessionid"];
  for (const key of pass) {
    const v = req.headers[key];
    if (typeof v === "string" && v) headers.set(key, v);
  }
  headers.set("origin", origin);
  headers.set("referer", origin + "/");
  return headers;
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

export function registerAbGameProxy(options: RegisterOptions) {
  const { app, server, hasActiveSession } = options;

  const proxyHandler = async (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).send("AB proxy session expired");
    const target = new URL((req.originalUrl || req.url || "/").replace(/^\/api\/vendor\/ab\/upstream/, "") || "/", session.origin);
    target.hash = "";
    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers: copyUpstreamHeaders(req, session.origin),
        redirect: "manual",
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (req.body != null && /application\/json/.test(ct)) init.body = JSON.stringify(req.body);
        else { init.body = req as any; init.duplex = "half"; }
      }
      const upstream = await fetch(target, init as any);
      const location = upstream.headers.get("location");
      if (location && upstream.status >= 300 && upstream.status < 400) {
        const next = new URL(location, target);
        if (next.origin === session.origin) {
          res.status(upstream.status).setHeader("Location", "/api/vendor/ab/upstream" + next.pathname + next.search).end();
          return;
        }
        res.status(upstream.status).setHeader("Location", next.toString()).end();
        return;
      }
      const contentType = upstream.headers.get("content-type") || "";
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
      res.status(upstream.status);
      forwardResponseHeaders(upstream, res, isHtml);
      if (req.method === "HEAD" || upstream.status === 204 || upstream.status === 304 || !upstream.body) return res.end();
      if (isHtml) {
        const html = await upstream.text();
        res.type("html").send(injectAbHook(html, session.sessionId, session.origin));
        return;
      }
      if (/json/i.test(contentType)) {
        const text = await upstream.text();
        try {
          const json = JSON.parse(text);
          getVendorRelay(session.sessionId, "AB")?.ingest(json);
        } catch {}
        res.send(text);
        return;
      }
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (error: any) {
      console.error(`[AB proxy] HTTP failed｜${req.method} ${req.path}｜${error?.message || error}`);
      if (!res.headersSent) res.status(502).send("AB proxy upstream failed");
      else res.end();
    }
  };

  app.use("/api/vendor/ab/upstream", proxyHandler);

  function isAbApiGwUrl(raw: string) {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" || isPrivateHost(url.hostname) || !/\/api-gw\//i.test(url.pathname)) return null;
    return url;
  }

  app.all("/api/vendor/ab/apigw", async (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).send("AB proxy session expired");
    const target = isAbApiGwUrl(String(req.query?.target || ""));
    if (!target) return res.status(400).send("invalid_ab_api");
    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers: copyUpstreamHeaders(req, session.origin),
        redirect: "manual",
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (req.body != null && /application\/json/.test(ct)) init.body = JSON.stringify(req.body);
        else { init.body = req as any; init.duplex = "half"; }
      }
      const upstream = await fetch(target, init as any);
      const contentType = upstream.headers.get("content-type") || "";
      res.status(upstream.status);
      forwardResponseHeaders(upstream, res, false);
      if (req.method === "HEAD" || upstream.status === 204 || upstream.status === 304 || !upstream.body) return res.end();
      if (/json/i.test(contentType)) {
        const text = await upstream.text();
        try {
          const json = JSON.parse(text);
          getVendorRelay(session.sessionId, "AB")?.ingest(json);
        } catch {}
        return res.send(text);
      }
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (error: any) {
      console.error(`[AB proxy] apigw failed｜${req.method} ${target.pathname}｜${error?.message || error}`);
      if (!res.headersSent) res.status(502).send("AB api-gw proxy failed");
      else res.end();
    }
  });

  const enterAb = async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || parseCookie(req.headers.cookie, COOKIE_NAME) || "");
    const device = String(req.body?.device || "") === "Mobile" ? "Mobile" : "Desktop";
    if (!sessionId || !hasActiveSession(sessionId)) return res.status(401).json({ ok: false, error: "session_invalid" });
    const relay = getVendorRelay(sessionId, "AB");
    if (!relay) return res.status(404).json({ ok: false, error: "relay_not_found" });
    setAbGameForeground(sessionId, true);
    await stopOtherVendorRelays(sessionId, "AB");
    await relay.pauseTransport();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reuse = req.body?.reuse === true;
    const kicked = relay.consumeAbKicked();
    // 進入平台走官方 AB01/login（自動轉點）。F5 留在遊戲才 reuse，避免再踢一次。
    const needLogin =
      !!relay.launchAuth &&
      (!reuse || kicked || !vendorLaunchIsReady("AB", relay.gameUrl));
    if (needLogin) {
      try {
        relay.gameUrl = await fetchVendorLaunchUrl({
          ...relay.launchAuth,
          kind: "AB",
          device,
        });
        relay.persistRuntime();
      } catch (error: any) {
        console.warn(`[AB proxy] enter launch failed｜${error?.message || error}`);
        return res.status(502).json({ ok: false, error: String(error?.message || "歐博授權失敗") });
      }
    }
    let url: URL;
    try { url = new URL(relay.gameUrl); } catch { return res.status(400).json({ ok: false, error: "invalid_game_url" }); }
    if (url.protocol !== "https:" || isPrivateHost(url.hostname)) return res.status(400).json({ ok: false, error: "invalid_game_url" });
    proxySessions.set(sessionId, { sessionId, origin: url.origin, launchUrl: url.toString(), lastUsed: Date.now() });
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    console.log(`[AB proxy] enter｜device=${device}｜host=${url.hostname}`);
    return res.json({ ok: true, url: abIframeUrl(sessionId, url.toString(), device) });
  };

  app.post("/api/vendor/ab/enter", enterAb);
  app.post("/api/vendor/ab/revive", enterAb);

  app.post("/api/vendor/ab/leave", async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) return res.status(400).json({ ok: false });
    setAbGameForeground(sessionId, false);
    res.setHeader("Set-Cookie", endAbProxyForeground(sessionId));
    console.log(`[AB proxy] leave｜session=${sessionId.slice(0, 8)}`);
    const relay = getVendorRelay(sessionId, "AB");
    try { await relay?.resumeTransport(); } catch (error: any) { console.warn(`[AB proxy] resume failed｜${error?.message || error}`); }
    return res.json({ ok: true });
  });

  app.post("/api/vendor/ingest", (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    const kind = String(req.body?.kind || "AB") as VendorKind;
    const relay = getVendorRelay(sessionId, kind === "DB" ? "DB" : "AB");
    if (!relay || !hasActiveSession(sessionId)) return res.status(401).json({ ok: false });
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    for (const message of messages.slice(0, 64)) {
      if (message && typeof message === "object") relay.ingest(message);
    }
    return res.json({ ok: true });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "", "http://localhost");
      if (u.pathname !== "/api/vendor/ab/ws") return;
      handleAbWsUpgrade(req, socket as Socket, head, options);
    } catch { try { socket.destroy(); } catch {} }
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, item] of proxySessions) if (now - item.lastUsed > 6 * 60 * 60 * 1000) proxySessions.delete(sid);
  }, 30 * 60 * 1000);
  timer.unref?.();
}

function openUpstreamWs(target: URL, extraHeaders: Record<string, string>) {
  return new Promise<{ socket: Socket; head: Buffer; protocol: string }>((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const tls = target.protocol === "wss:";
    const port = Number(target.port || (tls ? 443 : 80));
    let settled = false;
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const req = (tls ? https : http).request({
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        Host: target.host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...extraHeaders,
      },
      servername: target.hostname,
      timeout: 15000,
    });
    req.on("upgrade", (res, socket, upgradeHead) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 101) {
        socket.destroy();
        fail(new Error(`upstream ws ${res.statusCode}`));
        return;
      }
      settled = true;
      try { req.setTimeout(0); } catch {}
      try { socket.setTimeout(0); socket.setKeepAlive(true, 15000); socket.setNoDelay(true); } catch {}
      resolve({
        socket: socket as Socket,
        head: Buffer.from(upgradeHead || []),
        protocol: String(res.headers["sec-websocket-protocol"] || ""),
      });
    });
    req.on("response", (res) => {
      res.resume();
      fail(new Error(`upstream ws http ${res.statusCode}`));
    });
    req.on("error", fail);
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("upstream ws timeout"));
    });
    req.end();
  });
}

function handleAbWsUpgrade(req: IncomingMessage, client: Socket, head: Buffer, options: RegisterOptions) {
  let parsed: URL;
  try { parsed = new URL(req.url || "", "http://localhost"); } catch { client.destroy(); return; }
  const sessionId = parsed.searchParams.get("sessionId") || "";
  const targetRaw = parsed.searchParams.get("target") || "";
  if (!sessionId || !options.hasActiveSession(sessionId)) { client.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const proxySession = proxySessions.get(sessionId);
  const relay = getVendorRelay(sessionId, "AB");
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
  const extraHeaders: Record<string, string> = {
    Origin: proxySession.origin,
    "User-Agent": String(req.headers["user-agent"] || ""),
  };
  if (proto) extraHeaders["Sec-WebSocket-Protocol"] = proto;
  console.log(`[AB proxy] WS ${target.hostname}${proto ? `｜proto=${proto}` : ""}`);
  void openUpstreamWs(target, extraHeaders).then(({ socket: upstream, head: upstreamHead, protocol }) => {
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${wsAccept(browserKey)}`,
    ];
    const replyProto = protocol || proto;
    if (replyProto) lines.push(`Sec-WebSocket-Protocol: ${replyProto}`);
    lines.push("\r\n");
    client.write(lines.join("\r\n"));
    if (upstreamHead?.length) client.write(upstreamHead);
    if (head?.length) upstream.write(head);
    let closed = false;
    const finish = (why = "") => {
      if (closed) return;
      closed = true;
      if ((why === "upstream-end" || why === "upstream-close") && !loggedOpcode) relay.noteAbKicked("empty-ws");
      else if (sawKick) relay.noteAbKicked("6008");
      console.log(`[AB proxy] WS close｜${target.hostname}${why ? `｜${why}` : ""}`);
      try { upstream.destroy(); } catch {}
      try { client.destroy(); } catch {}
    };
    let loggedOpcode = false;
    let sawKick = false;
    const ingestJson = (text: string) => {
      try { relay.ingest(JSON.parse(text)); } catch {}
    };
    const ingestTap = new ClientFrameTap(
      (text) => {
        if (/6008|其他地方登入|\[6076\]|SessionID錯誤/i.test(text)) {
          sawKick = true;
          console.warn(`[AB proxy] WS 6008｜${target.hostname}`);
          relay.noteAbKicked("6008");
        }
        ingestJson(text);
      },
      (opcode, payload) => {
        if (!loggedOpcode && (opcode === 1 || opcode === 2)) {
          loggedOpcode = true;
          console.log(`[AB proxy] WS first frame opcode=${opcode} bytes=${payload.length}`);
        }
        if (opcode !== 2) return;
        try {
          const text = payload.toString("utf8");
          if (text.startsWith("{") || text.startsWith("[")) ingestJson(text);
        } catch {}
      },
    );
    const outTap = new ClientFrameTap(
      ingestJson,
      (opcode, payload) => {
        if (opcode !== 2) return;
        try {
          const text = payload.toString("utf8");
          if (text.startsWith("{") || text.startsWith("[")) ingestJson(text);
        } catch {}
      },
    );
    client.on("data", (chunk) => {
      if (closed) return;
      outTap.push(Buffer.from(chunk));
      try { upstream.write(chunk); } catch { finish(); }
    });
    upstream.on("data", (chunk) => {
      if (closed) return;
      const buf = Buffer.from(chunk);
      ingestTap.push(buf);
      try { client.write(buf); } catch { finish(); }
    });
    client.on("error", () => finish("client-error"));
    client.on("close", () => finish("client-close"));
    upstream.on("error", () => finish("upstream-error"));
    upstream.on("close", () => finish("upstream-close"));
    upstream.on("end", () => finish("upstream-end"));
  }).catch((error: any) => {
    console.warn(`[AB proxy] WS upstream failed｜${target.hostname}｜${error?.message || error}`);
    try { client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch { try { client.destroy(); } catch {} }
  });
}
