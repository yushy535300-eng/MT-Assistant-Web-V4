import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter, hasActiveTrackerSession, requireTrackerSession } from "../routers";
import { createContext } from "./context";
import { randomUUID } from "node:crypto";
import { adminPage } from "../admin-page";
import { listWhitelist, upsertWhitelist, setWhitelistEnabled, extendWhitelist, deleteWhitelist } from "../whitelist";
import { startDgRelay, getDgRelay, stopDgRelay, findDgRelayByToken, sweepIdleDgRelays } from "../dg-relay";
import { registerDgGameProxy } from "../dg-game-proxy";
import { registerAbGameProxy, hasAbForegroundCookie, restoreAbProxySession, endAbProxyForeground } from "../vendor-ab-proxy";
import { registerDbGameProxy, hasDbForegroundCookie, restoreDbProxySession, endDbProxyForeground } from "../vendor-db-proxy";
import { getVendorRelay, startVendorRelay, adoptPausedVendorRelay, stopVendorRelay, sweepVendorRelays, shouldIgnorePausedVendorStart, setAbGameForeground, type VendorKind } from "../vendor-relay";
import { fetchVendorLaunchUrl, vendorLaunchIsReady } from "../vendor-launch";
import { killLeftoverVendorChrome, getChromeStatus } from "../vendor-chromium";
import { loadPersistedVendors } from "../vendor-persist";
import { restoreTrackerSessions } from "../sessions";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  await restoreTrackerSessions();
  killLeftoverVendorChrome();
  const app = express();
  const server = createServer(app);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ limit: "5mb", extended: true }));

  // Foreground same-session proxies. These are intentionally registered
  // before the app's static catch-all. MT routes / sockets are untouched.
  registerDgGameProxy({ app, server, hasActiveSession: hasActiveTrackerSession, getRelay: getDgRelay });
  registerAbGameProxy({ app, server, hasActiveSession: hasActiveTrackerSession });
  registerDbGameProxy({ app, server, hasActiveSession: hasActiveTrackerSession });
  for (const row of loadPersistedVendors()) {
    if (!row.paused || !row.gameUrl) continue;
    try {
      await adoptPausedVendorRelay(row.sessionId, row.kind, row.gameUrl);
      if (row.kind === "AB") {
        setAbGameForeground(row.sessionId, true);
        restoreAbProxySession(row.sessionId, row.gameUrl);
      }
      if (row.kind === "DB") restoreDbProxySession(row.sessionId, row.gameUrl);
      console.log(`[Vendor API] restored paused｜kind=${row.kind}｜session=${row.sessionId.slice(0,8)}`);
    } catch (error: any) {
      console.warn(`[Vendor API] restore paused failed｜kind=${row.kind}｜${error?.message || error}`);
    }
  }

  app.get("/api/health", (_req, res) => {
    const mem=process.memoryUsage();
    const chrome=getChromeStatus();
    res.json({
      ok: true,
      timestamp: Date.now(),
      chrome,
      memoryMb: { rss: Math.round(mem.rss/1048576), heapUsed: Math.round(mem.heapUsed/1048576) },
    });
  });
  app.get("/api/vendor/chrome", (_req, res) => {
    res.json({ ok: true, ...getChromeStatus() });
  });

  const dgSweepTimer=setInterval(()=>{
    const result=sweepIdleDgRelays(180000);
    if(result.stopped)console.log(`[DG cleanup] stopped=${result.stopped} active=${result.active}`);
  },60000);
  dgSweepTimer.unref?.();
  const vendorSweepTimer=setInterval(()=>sweepVendorRelays(900000),60000);vendorSweepTimer.unref?.();

  const vendorKind=(raw:any):VendorKind|null=>raw==="AB"||raw==="DB"?raw:null;
  app.post("/api/vendor/start",async(req,res)=>{
    const sessionId=String(req.body?.sessionId||""),kind=vendorKind(req.body?.kind);
    const platform=req.body?.platform==="OFA"?"OFA":req.body?.platform==="TZ"?"TZ":"";
    const platformToken=String(req.body?.platformToken||"").trim();
    let gameUrl=String(req.body?.gameUrl||"");
    if(!(await requireTrackerSession(sessionId)))return res.status(401).json({ok:false,error:"session_invalid"});
    if(!kind)return res.status(400).json({ok:false,error:"invalid_vendor"});
    try{
      const existing=getVendorRelay(sessionId,kind);
      const resumeHall=req.body?.resumeHall===true||req.body?.resume===true;
      const inGameCookie=kind==="AB"?hasAbForegroundCookie(req.headers.cookie, sessionId):hasDbForegroundCookie(req.headers.cookie, sessionId);
      if(resumeHall){
        if(kind==="AB")setAbGameForeground(sessionId,false);
        res.setHeader("Set-Cookie", kind==="AB"?endAbProxyForeground(sessionId):endDbProxyForeground(sessionId));
      }
      if(shouldIgnorePausedVendorStart(resumeHall, !!existing?.isPausedForGame(), inGameCookie)){
        const url=existing?.gameUrl||gameUrl||(kind==="AB"?"https://www.ab8888.games:8888/":"");
        if(!url && kind==="DB")return res.status(400).json({ok:false,error:"invalid_game_url"});
        const launchAuth=existing?.launchAuth||(platform&&platformToken?{platform:platform as "TZ"|"OFA",platformToken}:undefined);
        const relay=existing?.isPausedForGame()?existing:await adoptPausedVendorRelay(sessionId,kind,url,launchAuth);
        if(kind==="AB"){
          setAbGameForeground(sessionId,true);
          restoreAbProxySession(sessionId, relay.gameUrl);
        }
        if(kind==="DB")restoreDbProxySession(sessionId, relay.gameUrl);
        console.log(`[Vendor API] start ignored｜kind=${kind}｜${existing?.isPausedForGame()?"paused":"foreground-cookie"}｜session=${sessionId.slice(0,8)}`);
        return res.json({ok:true,paused:true,host:(()=>{try{return new URL(relay.gameUrl).hostname}catch{return kind==="AB"?"www.ab8888.games":""}})()});
      }
      if(resumeHall && existing?.isPausedForGame()){
        if(platform&&platformToken){
          existing.launchAuth={platform:platform as "TZ"|"OFA",platformToken};
          if(kind==="DB"){
            // 回牌路沿用現有 params，不再打 TZ 登入，避免「重複登入」把大廳踢掉。
          }else if(!vendorLaunchIsReady(kind, existing.gameUrl)){
            gameUrl=await fetchVendorLaunchUrl({platform,platformToken,kind});
            existing.gameUrl=gameUrl;
          }
        }
        console.log(`[Vendor API] resume hall｜kind=${kind}｜session=${sessionId.slice(0,8)}`);
        void existing.resumeTransport();
        return res.json({ok:true,resumed:true,host:(()=>{try{return new URL(existing.gameUrl).hostname}catch{return ""}})()});
      }
      if(existing && !req.body?.restart){
        if(platform&&platformToken)existing.launchAuth={platform:platform as "TZ"|"OFA",platformToken};
        if(kind==="DB" && existing.needsHallRecover()){
          console.log(`[Vendor API] recover hall｜kind=DB｜session=${sessionId.slice(0,8)}`);
          void existing.recoverDbHall("reuse");
          return res.json({ok:true,recovered:true,host:(()=>{try{return new URL(existing.gameUrl).hostname}catch{return ""}})()});
        }
        void existing.ensureRunning();
        console.log(`[Vendor API] reuse｜kind=${kind}｜session=${sessionId.slice(0,8)}`);
        return res.json({ok:true,reused:true,host:(()=>{try{return new URL(existing.gameUrl).hostname}catch{return ""}})()});
      }
      if(platform&&platformToken){
        const fromClient=String(gameUrl||"");
        const saved=loadPersistedVendors().find((row)=>row.sessionId===sessionId&&row.kind===kind);
        const stored=String(existing?.gameUrl||saved?.gameUrl||"");
        if(vendorLaunchIsReady(kind, fromClient)) gameUrl=fromClient;
        else if(vendorLaunchIsReady(kind, stored)) gameUrl=stored;
        else gameUrl=await fetchVendorLaunchUrl({platform,platformToken,kind});
      }
      let u:URL;try{u=new URL(gameUrl)}catch{return res.status(400).json({ok:false,error:"invalid_game_url"})}
      if(u.protocol!=="https:")return res.status(400).json({ok:false,error:"invalid_game_url"});
      console.log(`[Vendor API] start｜kind=${kind}｜host=${u.hostname}｜auth=${platform&&platformToken?"server":"client-url"}｜session=${sessionId.slice(0,8)}`);
      await startVendorRelay(sessionId,kind,u.toString(),!!req.body?.restart,platform&&platformToken?{platform,platformToken}:undefined);
      return res.json({ok:true,host:u.hostname});
    }catch(e:any){
      console.error(`[Vendor API] start failed｜kind=${kind}｜${e?.message||e}`);
      return res.status(502).json({ok:false,error:e?.message||"vendor_start_failed"});
    }
  });
  app.get("/api/vendor/stream",async(req,res)=>{
    const sessionId=String(req.query.sessionId||""),kind=vendorKind(req.query.kind);
    if(!(await requireTrackerSession(sessionId)))return res.status(401).end();if(!kind)return res.status(400).end();
    const relay=getVendorRelay(sessionId,kind);if(!relay)return res.status(404).end();
    res.status(200);res.setHeader("Content-Type","text/event-stream; charset=utf-8");res.setHeader("Cache-Control","no-cache, no-transform");res.setHeader("Connection","keep-alive");res.setHeader("X-Accel-Buffering","no");(res as any).flushHeaders?.();
    const off=relay.subscribe(res);const keep=setInterval(()=>{try{res.write(": keepalive\n\n")}catch{}},15000);let done=false;const close=()=>{if(done)return;done=true;clearInterval(keep);off()};req.once("close",close);res.once("close",close);res.once("finish",close);
  });
  app.post("/api/vendor/stop",(req,res)=>{const sessionId=String(req.body?.sessionId||""),kind=vendorKind(req.body?.kind);if(!kind)return res.status(400).json({ok:false});stopVendorRelay(sessionId,kind);return res.json({ok:true})});

  const adminSessions = new Set<string>();
  const getAdminToken = (req:any) => {
    const headerToken = String(req.header("X-Admin-Token") || "");
    if (headerToken) return headerToken;
    const cookie = String(req.headers.cookie || "");
    const match = cookie.match(/(?:^|;\s*)mt_admin_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  };
  const requireAdmin = (req:any,res:any,next:any) => {
    const token = getAdminToken(req);
    if(!token || !adminSessions.has(token)) return res.status(401).json({error:"管理員登入已失效"});
    next();
  };
  const adminRedirect=(res:any,msg="")=>res.redirect(303,"/admin"+(msg?"?msg="+encodeURIComponent(msg):""));
  app.get("/admin", async (req,res)=>{
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
    const token=getAdminToken(req); const logged=!!token&&adminSessions.has(token);
    if(!logged) return res.type("html").send(adminPage(false));
    let items:any[]=[]; let dbError="";
    try { items=await listWhitelist(); console.log(`[MT Admin] whitelist loaded: ${items.length}`); }
    catch(e:any){ dbError=e?.message||"讀取失敗"; console.error("[MT Admin] whitelist load failed:",e); }
    res.type("html").send(adminPage(true,"",items,String(req.query.msg||""),dbError));
  });
  app.post("/api/admin/login", (req,res)=>{
    const expected=String(process.env.ADMIN_PASSWORD??"").trim(), supplied=String(req.body?.password??"").trim();
    if(!expected)return res.status(503).type("html").send(adminPage(false,"Render 尚未設定 ADMIN_PASSWORD"));
    if(supplied!==expected)return res.status(401).type("html").send(adminPage(false,"管理員密碼錯誤"));
    const token=randomUUID();adminSessions.add(token);res.setHeader("Set-Cookie",`mt_admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${process.env.NODE_ENV==="production"?"; Secure":""}`);adminRedirect(res);
  });
  app.post("/api/admin/logout-form",(req,res)=>{const t=getAdminToken(req);if(t)adminSessions.delete(t);res.setHeader("Set-Cookie",`mt_admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV==="production"?"; Secure":""}`);adminRedirect(res)});
  app.post("/api/admin/whitelist-form",requireAdmin,async(req,res)=>{try{const u=String(req.body?.username||"").trim();if(!u)return adminRedirect(res,"請輸入平台帳號");const platform=String(req.body?.platform||"TZ").toUpperCase();const d=String(req.body?.days||"permanent");await upsertWhitelist({username:u,platform,permanent:d==="permanent",days:d==="permanent"?null:Number(d),note:String(req.body?.note||"")});adminRedirect(res,`${u} 已新增並立即生效`)}catch(e:any){adminRedirect(res,`新增失敗：${e?.message||e}`)}});
  app.post("/api/admin/whitelist/:id/toggle-form",requireAdmin,async(req,res)=>{try{await setWhitelistEnabled(Number(req.params.id),String(req.body?.enabled)==="1");adminRedirect(res,"授權狀態已更新") }catch(e:any){adminRedirect(res,`操作失敗：${e?.message||e}`)}});
  app.post("/api/admin/whitelist/:id/extend-form",requireAdmin,async(req,res)=>{try{await extendWhitelist(Number(req.params.id),30);adminRedirect(res,"已延長 30 天")}catch(e:any){adminRedirect(res,`操作失敗：${e?.message||e}`)}});
  app.post("/api/admin/whitelist/:id/delete-form",requireAdmin,async(req,res)=>{try{await deleteWhitelist(Number(req.params.id));adminRedirect(res,"帳號已刪除") }catch(e:any){adminRedirect(res,`操作失敗：${e?.message||e}`)}});

  // Compatibility endpoint retained for older clients. Chromium has been removed
  // from the DG road path, so there is nothing to prewarm anymore.
  app.post("/api/dg/prewarm", (req,res)=>{
    const sessionId=String(req.body?.sessionId||"");
    if(!hasActiveTrackerSession(sessionId)) return res.status(401).json({ok:false,error:"session_invalid"});
    return res.json({ok:true,mode:"lightweight-ws"});
  });

  // DG relay: the browser keeps its normal TZ/DG login flow, while the server
  // owns the vendor WebSocket so the required DG Origin header can be preserved.
  app.post("/api/dg/start", async (req,res)=>{
    const sessionId=String(req.body?.sessionId||"");
    const gameUrl=String(req.body?.gameUrl||"");
    if(!hasActiveTrackerSession(sessionId)) return res.status(401).json({ok:false,error:"session_invalid"});
    let parsed:URL; try{parsed=new URL(gameUrl)}catch{return res.status(400).json({ok:false,error:"invalid_game_url"})}
    // DG rotates launch domains. Do not pin the relay to one historical
    // new-dd-cn.* hostname; validate the security properties instead.
    const host=parsed.hostname.toLowerCase();
    const looksLocal = host==="localhost" || host.endsWith(".localhost") || host==="0.0.0.0" || host==="::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    const hasToken=!!parsed.searchParams.get("token");
    // The DG launch path/domain can rotate between gateways. The relay only
    // needs a public HTTPS vendor origin plus the one-time token; do not reject
    // a valid launch URL merely because its path is no longer /ddnewpc/direct1.
    if(parsed.protocol!=="https:"||looksLocal||!hasToken) return res.status(400).json({ok:false,error:"invalid_game_url"});
    try{
      const result=await startDgRelay(sessionId,gameUrl);
      const status=result.relay.getStatus();
      if(result.reused) console.log(`[DG API] reuse｜status=${status}｜session=${sessionId.slice(0,8)}`);
      else console.log(`[DG API] start｜host=${parsed.hostname}｜path=${parsed.pathname}｜session=${sessionId.slice(0,8)}`);
      return res.json({ok:true,reused:result.reused,status});
    }
    catch(e:any){console.error("[DG relay] start failed",e);return res.status(502).json({ok:false,error:e?.message||"dg_start_failed"});}
  });
  app.get("/api/dg/stream",(req,res)=>{
    const sessionId=String(req.query.sessionId||"");
    if(!hasActiveTrackerSession(sessionId)) return res.status(401).end();
    const relay=getDgRelay(sessionId); if(!relay) return res.status(404).end();
    res.status(200);
    res.setHeader("Content-Type","text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control","no-cache, no-transform");
    res.setHeader("Connection","keep-alive");
    res.setHeader("X-Accel-Buffering","no");
    (res as any).flushHeaders?.();
    const unsubscribe=relay.subscribe(res);
    const keepalive=setInterval(()=>{try{res.write(": keepalive\n\n")}catch{}},15000);
    let cleaned=false;
    const cleanup=()=>{
      if(cleaned)return;
      cleaned=true;
      clearInterval(keepalive);
      try{unsubscribe()}catch{}
    };
    req.once("close",cleanup);
    res.once("close",cleanup);
    res.once("finish",cleanup);
  });
  app.post("/api/dg/stop",(req,res)=>{
    const sessionId=String(req.body?.sessionId||"");
    // Allow cleanup of an already-created relay even when the tracker session
    // has just expired/logged out. The opaque session id is still required.
    if(!hasActiveTrackerSession(sessionId) && !getDgRelay(sessionId)) return res.status(401).json({ok:false});
    stopDgRelay(sessionId); return res.json({ok:true});
  });


  // DG single-session browser bridge. When the user opens the real DG iframe,
  // stop the competing Render Chromium transport but keep the SAME relay object,
  // SSE subscribers and table cache alive. The companion extension mirrors the
  // foreground DG WebSocket's binary frames into this relay.
  app.post("/api/dg/bridge/enter", async (req,res)=>{
    const sessionId=String(req.body?.sessionId||"");
    if(!hasActiveTrackerSession(sessionId)) return res.status(401).json({ok:false,error:"session_invalid"});
    const relay=getDgRelay(sessionId);
    if(!relay) return res.status(404).json({ok:false,error:"relay_not_found"});
    try { relay.enterBridgeMode(); return res.json({ok:true}); }
    catch(e:any){ return res.status(500).json({ok:false,error:e?.message||"bridge_enter_failed"}); }
  });

  app.post("/api/dg/bridge/leave", async (req,res)=>{
    const sessionId=String(req.body?.sessionId||"");
    if(!hasActiveTrackerSession(sessionId)) return res.status(401).json({ok:false,error:"session_invalid"});
    const relay=getDgRelay(sessionId);
    if(!relay) return res.status(404).json({ok:false,error:"relay_not_found"});
    try { await relay.leaveBridgeMode(); return res.json({ok:true}); }
    catch(e:any){ return res.status(500).json({ok:false,error:e?.message||"bridge_leave_failed"}); }
  });

  app.post("/api/dg/bridge/status", (req,res)=>{
    const token=String(req.body?.token||"");
    const state=String(req.body?.state||"");
    const pageUrl=String(req.body?.pageUrl||"");
    const relay=findDgRelayByToken(token);
    if(!relay) return res.status(404).json({ok:false,error:"bridge_not_active"});
    if(state!=="open"&&state!=="close"&&state!=="error") return res.status(400).json({ok:false,error:"invalid_state"});
    relay.bridgeSocketState(state as "open"|"close"|"error",pageUrl);
    return res.json({ok:true});
  });

  app.post("/api/dg/bridge/frames", (req,res)=>{
    const token=String(req.body?.token||"");
    const relay=findDgRelayByToken(token);
    if(!relay) return res.status(404).json({ok:false,error:"bridge_not_active"});
    const frames=Array.isArray(req.body?.frames)?req.body.frames:[];
    if(!frames.length||frames.length>128) return res.status(400).json({ok:false,error:"invalid_frames"});
    let accepted=0;
    for(const raw of frames){
      if(typeof raw!=="string"||raw.length>2_000_000) continue;
      try {
        const data=Buffer.from(raw,"base64");
        if(!data.length||data.length>1_500_000) continue;
        if(relay.ingestBridgeFrame(data)) accepted++;
      } catch {}
    }
    return res.json({ok:true,accepted});
  });

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  const staticDir = path.resolve(__dirname, "../../web-dist");
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => console.log(`[MT Assistant] http://localhost:${port}`));
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
