import type { Express, Request, Response } from "express";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ensureDgRelayShell, type DgRelay } from "./dg-relay";
import { DG_REPORT_BRIDGE_SCRIPT } from "./dg-report-bridge";

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
  getRelay: (sessionId: string) => DgRelay | undefined;
};

const COOKIE_NAME = "mt_dg_proxy_sid";
const proxySessions = new Map<string, ProxySession>();

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

function safePublicHttpsOrigin(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid_dg_url"); }
  if (u.protocol !== "https:" || isPrivateHost(u.hostname)) throw new Error("invalid_dg_url");
  return u.origin;
}

function wsAccept(key: string) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function injectProxyHook(html: string, sessionId: string, upstreamOrigin: string) {
  const sid = JSON.stringify(sessionId);
  const origin = JSON.stringify(upstreamOrigin);
  const hook = `<script>(function(){\n` +
`const __sid=${sid},__origin=${origin};\n` +
`const NativeWS=window.WebSocket;\n` +
`if(!NativeWS||window.__MT_DG_PROXY_WS__)return;\n` +
`window.__MT_DG_PROXY_WS__=true;\n` +
DG_REPORT_BRIDGE_SCRIPT +
`const __frames=[];let __frameTimer=0,__flushing=false;\n` +
`const __flushFrames=async()=>{if(__flushing||!__frames.length)return;__flushing=true;clearTimeout(__frameTimer);__frameTimer=0;const frames=__frames.splice(0,64);try{await fetch(\"/api/dg/proxy/frames\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({frames}),keepalive:true});}catch{}finally{__flushing=false;if(__frames.length)__frameTimer=setTimeout(__flushFrames,30);}};\n` +
`const __mirrorFrame=async value=>{try{let buf;if(value instanceof ArrayBuffer)buf=value;else if(ArrayBuffer.isView(value))buf=value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);else if(typeof Blob!==\"undefined\"&&value instanceof Blob)buf=await value.arrayBuffer();else return;const bytes=new Uint8Array(buf);let binary=\"\";for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));__frames.push(btoa(binary));if(__frames.length>=32)void __flushFrames();else if(!__frameTimer)__frameTimer=setTimeout(__flushFrames,30);}catch{}};\n` +
`class MTDGWebSocket extends NativeWS{constructor(url,protocols){const raw=String(url||\"\");if(arguments.length>1)super(raw,protocols);else super(raw);this.addEventListener(\"message\",event=>{void __mirrorFrame(event.data);__pnlReceive(this,event);});}}\n` +
`window.WebSocket=MTDGWebSocket;\n` +
`const mapHttp=(value)=>{try{const raw=String(value||"");if(!raw)return value;const abs=raw.startsWith("//")?location.protocol+raw:raw;if(!(raw.startsWith("http://")||raw.startsWith("https://")||raw.startsWith("//")))return value;const u=new URL(abs,location.href);if(u.origin===__origin)return u.pathname+u.search+u.hash;if(u.hostname===location.hostname&&String(u.port||"")!==String(location.port||""))return u.pathname+u.search+u.hash;return value;}catch{return value;}};\n` +
`const nativeFetch=window.fetch;if(nativeFetch){window.fetch=function(input,init){if(typeof input==="string"||input instanceof URL)return nativeFetch.call(this,mapHttp(String(input)),init);return nativeFetch.call(this,input,init);};}\n` +
`const xhrOpen=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;if(xhrOpen){XMLHttpRequest.prototype.open=function(method,url){const args=Array.from(arguments);args[1]=mapHttp(url);return xhrOpen.apply(this,args);};}\n` +
`const patchUrlProp=(proto,prop)=>{try{const d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set)return;Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,mapHttp(v));}});}catch{}};\n` +
`if(window.HTMLScriptElement)patchUrlProp(HTMLScriptElement.prototype,"src");\n` +
`if(window.HTMLLinkElement)patchUrlProp(HTMLLinkElement.prototype,"href");\n` +
`const setAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(name==="src"||name==="href")value=mapHttp(value);return setAttr.call(this,name,value);};\n` +
`window.__MT_DG_UPSTREAM_ORIGIN__=__origin;\n` +
`})();</script>`;
  let page = html;
  try {
    const host = new URL(upstreamOrigin).host;
    page = page.split(upstreamOrigin).join("");
    page = page.split(`//${host}`).join("");
  } catch {}
  if (/<head(?:\s[^>]*)?>/i.test(page)) return page.replace(/<head(?:\s[^>]*)?>/i, m => m + hook);
  return hook + page;
}

function copyUpstreamHeaders(req: Request, origin: string) {
  const headers = new Headers();
  const pass = ["accept", "accept-language", "cache-control", "pragma", "range", "if-none-match", "if-modified-since", "content-type", "user-agent"];
  for (const key of pass) {
    const v = req.headers[key];
    if (typeof v === "string" && v) headers.set(key, v);
  }
  if (req.headers.origin) headers.set("origin", origin);
  const referer = typeof req.headers.referer === "string" ? req.headers.referer : "";
  if (referer) {
    try {
      const local = new URL(referer);
      headers.set("referer", origin + local.pathname + local.search);
    } catch { headers.set("referer", origin + "/"); }
  } else {
    headers.set("referer", origin + "/");
  }
  return headers;
}

function forwardResponseHeaders(upstream: globalThis.Response, res: Response, rewritten: boolean) {
  const blocked = new Set([
    "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "set-cookie",
    "content-security-policy", "content-security-policy-report-only", "x-frame-options", "cross-origin-opener-policy",
    "cross-origin-embedder-policy", "cross-origin-resource-policy"
  ]);
  upstream.headers.forEach((value, key) => {
    if (blocked.has(key.toLowerCase())) return;
    try { res.setHeader(key, value); } catch {}
  });
  if (rewritten) res.setHeader("Cache-Control", "no-store");
}

function sessionFromRequest(req: Request) {
  const sid = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (!sid) return null;
  const session = proxySessions.get(sid);
  if (!session) return null;
  session.lastUsed = Date.now();
  return session;
}

class ServerFrameTap {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  constructor(private onBinary: (payload: Buffer) => void) {}
  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, pos = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); pos = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(16 * 1024 * 1024)) { this.buffer = Buffer.alloc(0); return; }
        len = Number(big); pos = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (len > 16 * 1024 * 1024) { this.buffer = Buffer.alloc(0); return; }
      if (this.buffer.length < pos + maskBytes + len) return;
      let payload = Buffer.from(this.buffer.subarray(pos + maskBytes, pos + maskBytes + len));
      if (masked) {
        const mask = this.buffer.subarray(pos, pos + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
      }
      this.buffer = this.buffer.subarray(pos + maskBytes + len);
      if (opcode === 0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments); const op = this.fragmentOpcode;
          this.fragments = []; this.fragmentOpcode = 0;
          if (op === 2) this.onBinary(full);
        }
        continue;
      }
      if (!fin && (opcode === 1 || opcode === 2)) {
        this.fragmentOpcode = opcode; this.fragments = [payload]; continue;
      }
      if (fin && opcode === 2) this.onBinary(payload);
    }
  }
}

function encodeServerWsFrame(opcode: number, payload: Buffer) {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4); head[0] = 0x80 | (opcode & 0x0f); head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x80 | (opcode & 0x0f); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function handleGameWsUpgrade(req: IncomingMessage, client: Socket, head: Buffer, options: RegisterOptions) {
  let parsed: URL;
  try { parsed = new URL(req.url || "", "http://localhost"); } catch { client.destroy(); return; }
  if (parsed.pathname !== "/api/dg/game-ws") return;
  const sessionId = parsed.searchParams.get("sessionId") || "";
  const targetRaw = parsed.searchParams.get("target") || "";
  if (!sessionId || !options.hasActiveSession(sessionId)) { client.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const proxySession = proxySessions.get(sessionId);
  const relay = options.getRelay(sessionId);
  if (!proxySession || !relay) { client.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  let target: URL | null = null;
  try { target = targetRaw ? new URL(targetRaw) : null; } catch {}
  if (target && (target.protocol !== "wss:" || isPrivateHost(target.hostname))) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const browserKey = String(req.headers["sec-websocket-key"] || "");
  if (!browserKey) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }

  // This is a local view over the relay's ONE already-authenticated upstream.
  // Duplicate page bootstrap messages are handled locally by DgRelay; only
  // actual gameplay operations are allowed through to the vendor socket.
  const response = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${wsAccept(browserKey)}`,
    "\r\n",
  ].join("\r\n");
  client.write(response);
  relay.bridgeSocketState("open", proxySession.launchUrl);
  console.log(`[DG proxy] foreground local WS 101｜upstream=lightweight-single-session｜session=${sessionId.slice(0,8)}`);

  let closed = false;
  const queue: Buffer[] = [];
  let draining = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const writeLocal = (payload: Buffer) => {
    if (closed || client.destroyed || !payload?.length) return;
    try { client.write(encodeServerWsFrame(2, payload)); } catch {}
  };

  const drain = async () => {
    if (closed || draining) return;
    draining = true;
    try {
      while (!closed && queue.length) {
        const ok = await relay.forwardForegroundFrame(queue[0]!, writeLocal);
        if (!ok) {
          retryTimer = setTimeout(() => { retryTimer = null; void drain(); }, 120);
          retryTimer.unref?.();
          break;
        }
        queue.shift();
      }
    } finally { draining = false; }
  };

  const tap = new ServerFrameTap(payload => {
    if (closed || !payload?.length) return;
    // Bound the queue so a dead browser cannot consume unbounded memory.
    if (queue.length >= 256) queue.shift();
    queue.push(Buffer.from(payload));
    void drain();
  });

  const detach = relay.attachForegroundBridgeSink(writeLocal);

  const finish = (state: "close" | "error") => {
    if (closed) return;
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { detach(); } catch {}
    relay.bridgeSocketState(state, proxySession.launchUrl);
    try { client.destroy(); } catch {}
  };
  if (head?.length) tap.push(head);
  client.on("data", chunk => tap.push(chunk));
  client.on("error", () => finish("error"));
  client.on("close", () => finish("close"));
}

export function registerDgGameProxy(options: RegisterOptions) {
  const { app, server, hasActiveSession, getRelay } = options;

  app.post("/api/dg/proxy/report-request", (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).json({ ok: false });
    const relay = getRelay(session.sessionId);
    if (!relay) return res.status(404).json({ ok: false });
    res.setHeader("Cache-Control", "no-store");
    const frame = relay.createPnlRequest();
    return res.json({ ok: true, frame: frame?.toString("base64") ?? null });
  });

  // Mirror the binary frames received by the actual DG page into the existing
  // relay. This does not create or authenticate another DG WebSocket.
  app.post("/api/dg/proxy/frames", (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).json({ ok: false, error: "session_invalid" });
    const relay = getRelay(session.sessionId);
    if (!relay) return res.status(404).json({ ok: false, error: "relay_not_found" });
    const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
    if (!frames.length || frames.length > 64) return res.status(400).json({ ok: false, error: "invalid_frames" });
    let accepted = 0;
    for (const raw of frames) {
      if (typeof raw !== "string" || raw.length > 2_000_000) continue;
      try {
        const data = Buffer.from(raw, "base64");
        if (!data.length || data.length > 1_500_000) continue;
        if (relay.ingestBridgeFrame(data)) accepted++;
      } catch {}
    }
    return res.json({ ok: true, accepted });
  });

  // These paths mirror DG's own same-origin layout. Register them BEFORE the
  // normal JSON/body parsers and app static handler, so the foreground game can
  // run as a first-party iframe without any browser extension.
  const proxyHandler = async (req: Request, res: Response) => {
    const session = sessionFromRequest(req);
    if (!session || !hasActiveSession(session.sessionId)) return res.status(401).send("DG proxy session expired");
    const target = new URL(req.originalUrl || req.url, session.origin);
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
        else if (req.body != null && /application\/x-www-form-urlencoded/.test(ct)) init.body = new URLSearchParams(req.body as Record<string,string>).toString();
        else { init.body = req as any; init.duplex = "half"; }
      }
      const upstream = await fetch(target, init as any);
      const location = upstream.headers.get("location");
      if (location && upstream.status >= 300 && upstream.status < 400) {
        const next = new URL(location, target);
        if (next.origin === session.origin) {
          res.status(upstream.status).setHeader("Location", next.pathname + next.search).end();
          return;
        }
        res.status(upstream.status).setHeader("Location", next.toString()).end();
        return;
      }
      const contentType = upstream.headers.get("content-type") || "";
      // Some DG gateways return index.html with a non-HTML Content-Type. The
      // hook is mandatory, so use the requested pathname as an authority too.
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || /(?:^|\/)index\.html$/i.test(target.pathname);
      res.status(upstream.status);
      forwardResponseHeaders(upstream, res, isHtml);
      if (req.method === "HEAD" || upstream.status === 204 || upstream.status === 304 || !upstream.body) return res.end();
      if (isHtml) {
        const html = await upstream.text();
        res.type("html").send(injectProxyHook(html, session.sessionId, session.origin));
        return;
      }
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (error: any) {
      console.error(`[DG proxy] HTTP failed｜${req.method} ${req.path}｜${error?.message || error}`);
      if (!res.headersSent) res.status(502).send("DG proxy upstream failed");
      else res.end();
    }
  };

  app.use("/ddnewpc", proxyHandler);
  app.use("/ddnewwap", proxyHandler);
  app.use("/static", proxyHandler);
  app.use("/vd", proxyHandler);
  app.use("/apidata", proxyHandler);
  app.use("/giftrobot", proxyHandler);

  // Parent-page control endpoints. They only affect DG; MT never enters this path.
  app.post("/api/dg/proxy/enter", async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    const gameUrl = String(req.body?.gameUrl || "");
    if (!sessionId || !hasActiveSession(sessionId)) return res.status(401).json({ ok: false, error: "session_invalid" });
    let url: URL;
    try { url = new URL(gameUrl); } catch { return res.status(400).json({ ok: false, error: "invalid_game_url" }); }
    let origin = "";
    try { origin = safePublicHttpsOrigin(gameUrl); } catch { return res.status(400).json({ ok: false, error: "invalid_game_url" }); }
    if (!url.searchParams.get("token")) return res.status(400).json({ ok: false, error: "missing_token" });
    ensureDgRelayShell(sessionId, gameUrl).enterBridgeMode();
    // Give the just-stopped headless Chromium socket a brief moment to fully close
    // before the foreground browser establishes the one replacement DG session.
    await new Promise(resolve => setTimeout(resolve, 250));
    proxySessions.set(sessionId, { sessionId, origin, launchUrl: gameUrl, lastUsed: Date.now() });
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return res.json({ ok: true, url: url.pathname + url.search });
  });

  app.post("/api/dg/proxy/leave", async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId || (!hasActiveSession(sessionId) && !getRelay(sessionId))) return res.status(401).json({ ok: false, error: "session_invalid" });
    proxySessions.delete(sessionId);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    const relay = getRelay(sessionId);
    if (relay) {
      try { await relay.leaveBridgeMode(); }
      catch (error: any) { console.warn(`[DG proxy] leave background restore failed｜${error?.message || error}`); }
    }
    return res.json({ ok: true });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "", "http://localhost");
      if (u.pathname !== "/api/dg/game-ws") return;
      handleGameWsUpgrade(req, socket as Socket, head, options);
    } catch { try { socket.destroy(); } catch {} }
  });

  // Avoid stale proxy records lingering forever if a browser disappears without
  // pressing 回牌路. This does not touch the relay itself.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sid, item] of proxySessions) if (now - item.lastUsed > 6 * 60 * 60 * 1000) proxySessions.delete(sid);
  }, 30 * 60 * 1000);
  timer.unref?.();
}
