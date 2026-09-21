import {describe,expect,it} from "vitest";
import {abCategory,abDealerName,abHandRound,abPoker,abRank,abRoad,abRoadFromCards,dbCategory,dbDecodeBeatPlate,dbExtractWsJson,dbFlattenPacket,dbPickLang,dbResolveCategory,dbRoomTitle,ingestDbPackets,isAbSessionBlockedCapture,isDbHallBlockedCapture,nextDbWafBlockMs,shouldIgnorePausedVendorStart} from "../server/vendor-relay";
import { pickLaunchUrl, preferDbVueUrl, preferDbMobileUrl, vendorLaunchIsReady } from "../server/vendor-launch";
import {resolveDbProxyPathname,sanitizeDbUpstreamSearch,hasDbForegroundCookie} from "../server/vendor-db-proxy";
import {rememberDbChromeResponse,readDbChromeResponse} from "../server/vendor-db-cache";
import {hasAbForegroundCookie} from "../server/vendor-ab-proxy";
import {loadPersistedVendors, removePersistedVendor, upsertPersistedVendor} from "../server/vendor-persist";

describe("歐博 HAR 協議",()=>{
  it("以路紙內的莊閒點數判定勝負",()=>{
    expect(abRoad("164020A00300")).toBe("莊"); // 莊6、閒4
    expect(abRoad("187000801000")).toBe("莊"); // 莊8、閒7
    expect(abRoad("177000000000")).toBe("和");
  });
  it("保留雙方最多三張牌並把十與人頭牌算零點",()=>{
    expect(abRank("412")).toBe(10);
    expect(abPoker([["303","401","412"],["306","112","-1"]])).toBe(JSON.stringify({player:"6-Q",banker:"3-A-Q"}));
  });
  it("只留下已確認的百家桌類別",()=>{
    expect([101,103,104,110,111].map(abCategory)).toEqual(["一般","快速","免佣","保險","VIP"]);
    expect(abCategory(301)).toBe("其他");
  });
  it("完整牌面後才判定勝負",()=>{
    expect(abRoadFromCards([["409","202"],["403","201"]])).toBe(null);
    expect(abRoadFromCards([["303"],["306","112"]])).toBe(null);
  });
  it("B201 實包把 -2 當未發牌並讀出閒莊",()=>{
    expect(abPoker([["-2","-2"],["-2","-2"]])).toBe(undefined);
    expect(abPoker([["304","411"],["110","404","111"]])).toBe(JSON.stringify({player:"10-4-J",banker:"4-J"}));
    expect(abPoker([["405","111","309"],["408","409"]])).toBe(JSON.stringify({player:"8-9",banker:"5-J-9"}));
  });
  it("局數只用鞋內把數，不把官方 ID 當成第 N 局",()=>{
    expect(abHandRound(31)).toBe(31);
    expect(abHandRound("12")).toBe(12);
    expect(abHandRound(527616216, 30)).toBe(30);
    expect(abHandRound(527616303)).toBe(0);
    expect(abHandRound(0, 527616256)).toBe(0);
    expect(abHandRound(undefined, 28)).toBe(28);
  });
  it("荷官顯示拿掉登入後綴，對齊桌面 Zelma",()=>{
    expect(abDealerName("Zelma_6603")).toBe("Zelma");
    expect(abDealerName("Lean_6698")).toBe("Lean");
    expect(abDealerName("Zelma")).toBe("Zelma");
  });
  it("今日輸贏不拿大廳 I/M 或全桌派彩當本人損益",()=>{
    const source=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    const ui=require("node:fs").readFileSync(require("node:path").resolve("app/index.tsx"),"utf8");
    expect(source).not.toContain("o.data.I??o.data.M");
    expect(source).not.toContain('broadcast("settlement"');
    expect(ui).not.toContain("(v[kind] ?? 0) + settlement.pnl");
  });
  it("進桌暫停狀態會寫進本機，重啟後仍視為同一場遊戲頁",()=>{
    const sid="test-paused-persist-ab";
    upsertPersistedVendor({sessionId:sid,kind:"AB",paused:true,gameUrl:"https://www.ab8888.games:8888/"});
    const saved=loadPersistedVendors().find((row)=>row.sessionId===sid&&row.kind==="AB");
    expect(saved?.paused).toBe(true);
    expect(saved?.gameUrl).toContain("ab8888.games");
    removePersistedVendor(sid,"AB");
    expect(loadPersistedVendors().some((row)=>row.sessionId===sid&&row.kind==="AB")).toBe(false);
  });
  it("前景 cookie 對得上才視為遊戲頁佔用",()=>{
    const sid="bace5ad6-6d32-4813-b36e-d4955280cdb8";
    expect(hasAbForegroundCookie(`mt_ab_proxy_sid=${sid}; other=1`, sid)).toBe(true);
    expect(hasAbForegroundCookie("mt_ab_proxy_sid=other", sid)).toBe(false);
    expect(hasAbForegroundCookie(undefined, sid)).toBe(false);
  });
  it("歐博 6076／SessionID 錯誤要當授權失效重連，不要直接連線失敗",()=>{
    expect(isAbSessionBlockedCapture("SessionID錯誤，請返回重新嘗試 [6076] 進入遊戲中... 100%")).toBe(true);
    expect(isAbSessionBlockedCapture("擷取狀態｜title=ALLBET｜ws=2")).toBe(false);
    const source=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(source).toContain("void this.recoverAbHall(\"empty\")");
    expect(source).toContain("void this.recoverAbHall(\"6076\")");
  });
  it("DB 403 擷取狀態不算已解析桌台",()=>{
    expect(isDbHallBlockedCapture("擷取狀態｜title=403 Forbidden｜text=Denied by http_ratelimit")).toBe(true);
    expect(isDbHallBlockedCapture("擷取狀態｜title=触手可及 最美真人娱乐场｜ws=1")).toBe(false);
  });
  it("DB 限流冷卻隨次數拉長，避免連續重開 Chrome",()=>{
    expect(nextDbWafBlockMs(1)).toBe(120000);
    expect(nextDbWafBlockMs(3)).toBe(360000);
    expect(nextDbWafBlockMs(10)).toBe(600000);
  });
  it("回牌路 resumeHall 必須蓋過 cookie／paused，遊戲頁才繼續忽略 start",()=>{
    expect(shouldIgnorePausedVendorStart(false,true,true)).toBe(true);
    expect(shouldIgnorePausedVendorStart(false,true,false)).toBe(true);
    expect(shouldIgnorePausedVendorStart(false,false,true)).toBe(true);
    expect(shouldIgnorePausedVendorStart(true,true,true)).toBe(false);
    expect(shouldIgnorePausedVendorStart(true,false,true)).toBe(false);
  });
  it("歐博／DB 啟動優先用瀏覽器拿到的授權網址，避免 Render 代打 TZ 被擋",()=>{
    const app=require("node:fs").readFileSync(require("node:path").resolve("app/index.tsx"),"utf8");
    expect(app).toContain("getVendorLoginUrlFromPlatform");
    expect(app).toContain("TZ 授權必須在瀏覽器打");
    expect(app).toContain("等待歐博背景瀏覽器就緒後再連 DB");
    const api=require("node:fs").readFileSync(require("node:path").resolve("server/_core/index.ts"),"utf8");
    expect(api).toContain("fromClient");
    expect(api).toContain("vendorLaunchIsReady(kind, fromClient)");
    expect(api).toContain("getChromeStatus");
  });
  it("Chromium 啟動失敗要標成連線失敗，不能只寫 log",()=>{
    const relay=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(relay).toContain("背景瀏覽器啟動失敗");
    expect(relay).toContain("歐博授權失效，請重新整理頁面");
    expect(relay).toContain("void relay.start()");
    const chrome=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-chromium.ts"),"utf8");
    expect(chrome).toContain("withChromeLaunchLock");
    expect(chrome).toContain("getChromeStatus");
  });
  it("歐博回牌路要等遊戲頁關掉才重開 Chrome，避免 6076",()=>{
    const source=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(source).toContain("遊戲頁關閉後再重開背景歐博，避免 6076");
    expect(source).toContain("2500");
    expect(source).toContain("isThisAbForeground");
  });
  it("歐博進桌要等背景 Chrome 行程結束，不能只標暫停就去打新授權",()=>{
    const chrome=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-chromium.ts"),"utf8");
    expect(chrome).toContain("waitUntilChromeDead");
    const relay=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(relay).toContain("背景瀏覽器已關閉，改由遊戲頁同步牌面");
    expect(relay).toContain("AB_SESSION_KICKED");
    expect(relay).toContain('recoverAbHall("leave")');
  });
  it("歐博今日輸贏走官方 betLog/records，不是大廳 I/M",()=>{
    const source=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-ab-proxy.ts"),"utf8");
    expect(source).toContain("vendorLaunchIsReady");
    expect(source).toContain("/api/vendor/ab/apigw");
    expect(source).toContain("betLog");
    expect(source).not.toContain("setInterval(pullBetLog");
    const relay=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(relay).toContain("www.hnyonyou.net/api-gw/webapi/betLog/records");
  });
  it("歐博今日輸贏只在進桌後開獎才抓報表",()=>{
    const relay=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-relay.ts"),"utf8");
    expect(relay).toContain("scheduleAbBetLogPull");
    expect(relay).toContain("applyAbPlayPacket");
    expect(relay).not.toContain("startAbPnlWatch");
  });
  it("離開遊戲後暫停旗標會清掉",()=>{
    const sid="test-unpause-persist-ab";
    upsertPersistedVendor({sessionId:sid,kind:"AB",paused:true,gameUrl:"https://www.ab8888.games:8888/?sessionId=abc"});
    upsertPersistedVendor({sessionId:sid,kind:"AB",paused:false,gameUrl:"https://www.ab8888.games:8888/?sessionId=abc"});
    const saved=loadPersistedVendors().find((row)=>row.sessionId===sid&&row.kind==="AB");
    expect(saved?.paused).toBe(false);
    removePersistedVendor(sid,"AB");
  });
});

describe("DB 大廳分類",()=>{
  it("對齊畫面上的極速／經典／共享分類",()=>{
    expect(dbCategory("終極百家樂")).toBe("極速");
    expect(dbCategory("包桌百家乐")).toBe("包桌");
    expect(dbCategory("")).toBe("");
    expect(dbResolveCategory({gameTypeId:2002,tableId:"301"})).toBe("極速");
    expect(dbResolveCategory({gameTypeName:"經典百家樂",tableId:"88"})).toBe("經典");
    expect(dbResolveCategory({tableId:"9",roadPaper:{beatPlateRoad:"AAA="}})).toBe("經典");
    expect(dbResolveCategory({gameTypeId:2013,tableId:"1"})).toBe("");
    expect(dbResolveCategory({tableId:"5a",roadPaper:{}})).toBe("");
  });
  it("大廳 map 的短代號要併回 tableId，不要另外長出空白經典桌",()=>{
    const hall=ingestDbPackets([
      {gameTableMap:{"5a":{tableId:2545,physicsTableNo:"5a",gameTypeId:2001,dealerName:"Urbana",tableName:"经典百家乐"}}},
      {tableNo:"6a",gameTypeName:"百家樂"},
      {roadPaperCacheMap:{2545:{tableId:2545,data:{beatPlateRoad:"KAYHpykIQpzEIUhWkOYlCNKQpDlIUhGMoQpCkIABQaCgwA=="}}}},
    ]);
    expect(hall.map((t)=>t.apiId)).toEqual(["2545"]);
    expect(hall[0].id).toBe("DB-5a");
    expect(hall[0].name).toBe("Urbana");
    expect(hall[0].roomId).toBe("经典百家乐5a");
    expect(hall[0].results.length).toBeGreaterThan(0);
  });
  it("極速桌標題用官方 tableName，例如 极速百家乐H26",()=>{
    const hall=ingestDbPackets([
      {tableId:2138,physicsTableNo:"H26",gameTypeId:2002,dealerName:"Melanie",tableName:"极速百家乐H26"},
    ]);
    expect(hall).toHaveLength(1);
    expect(hall[0].name).toBe("Melanie");
    expect(hall[0].id).toBe("DB-H26");
    expect(hall[0].roomId).toBe("极速百家乐H26");
  });
  it("解開外層 2013 廣播並讀大廳路紙快取",()=>{
    const envelope={
      protocolId:303,
      gameTypeId:2013,
      jsonData:JSON.stringify({
        id:303,
        gameTypeId:2013,
        data:JSON.stringify({
          tableId:2777,
          roundNo:"GJ4026920556",
          gameTypeId:2001,
          dealerName:"Sylvie",
          roadPaper:{beatPlateRoad:"KAYHpykIQpzEIUhWkOYlCNKQpDlIUhGMoQpCkIABQaCgwA=="},
        }),
      }),
    };
    expect(dbFlattenPacket(envelope).gameTypeId).toBe(2001);
    const hall=ingestDbPackets([
      {protocolId:10052,data:{gameTableMap:{2777:{tableId:2777,tableOnline:{onlineNumber:8},gameStatus:4}}}},
      {protocolId:10071,roadPaperCacheMap:{2777:{tableId:2777,data:{beatPlateRoad:"KAYHpykIQpzEIUhWkOYlCNKQpDlIUhGMoQpCkIABQaCgwA=="}}}},
      envelope,
    ]);
    expect(hall).toHaveLength(1);
    expect(hall[0].category).toBe("經典");
    expect(hall[0].name).toBe("Sylvie");
    expect(hall[0].roomId).toBe("2777");
    expect(hall[0].results.length).toBeGreaterThan(0);
    expect(dbDecodeBeatPlate("KAYHpykIQpzEIUhWkOYlCNKQpDlIUhGMoQpCkIABQaCgwA==").length).toBeGreaterThan(0);
  });
  it("即時局數用 bootIndex，開牌用 currentRoundExtInfos",()=>{
    const hall=ingestDbPackets([
      {tableId:2651,physicsTableNo:"B33",gameTypeId:2002,dealerName:"Flynn",tableName:"极速百家乐B33",bootNo:"B0B3326921003P-X288",roundNo:"GB3326921003P"},
      {tableId:2651,bootIndex:45,roundId:506311000,currentRoundExtInfos:[
        {cardOwner:0,ownerIndex:1,cardNumber:1},
        {cardOwner:0,ownerIndex:2,cardNumber:13},
        {cardOwner:1,ownerIndex:1,cardNumber:4},
        {cardOwner:1,ownerIndex:2,cardNumber:5},
      ]},
    ]);
    expect(hall).toHaveLength(1);
    expect(hall[0].round).toBe(45);
    expect(hall[0].poker).toBe(JSON.stringify({player:"A-K",banker:"4-5"}));
  });
  it("大廳後續快照沒帶牌面時不要把已開的牌清掉",()=>{
    const hall=ingestDbPackets([
      {tableId:2651,gameTypeId:2002,physicsTableNo:"B33",tableName:"极速百家乐B33",roundId:1,currentRoundExtInfos:[{cardOwner:0,ownerIndex:1,cardNumber:24}]},
      {tableId:2651,gameTypeId:2002,physicsTableNo:"B33",tableName:"极速百家乐B33",gameStatus:4},
    ]);
    expect(JSON.parse(String(hall[0].poker)).player).toBe("J");
  });
  it("binary WS 內嵌 JSON 用既有欄位讀局數與牌",()=>{
    const json=JSON.stringify({
      tableId:2651,physicsTableNo:"B33",gameTypeId:2002,dealerName:"Flynn",tableName:"极速百家乐B33",
      bootIndex:46,roundId:506311001,currentRoundExtInfos:[
        {cardOwner:0,ownerIndex:1,cardNumber:1},
        {cardOwner:1,ownerIndex:1,cardNumber:4},
      ],
    });
    const buf=Buffer.concat([Buffer.from([0x00,0x12,0x00]),Buffer.from(json,"utf8")]);
    const parsed=dbExtractWsJson(buf,true);
    expect(parsed?.bootIndex).toBe(46);
    const hall=ingestDbPackets([parsed,{__binary:[...buf]}]);
    expect(hall[0].round).toBe(46);
    expect(JSON.parse(String(hall[0].poker))).toEqual({player:"A",banker:"4"});
  });
  it("roundNo 字串不能當成 0 局，沒有 bootIndex 就用路紙長度",()=>{
    const hall=ingestDbPackets([{
      tableId:2777,gameTypeId:2001,roundNo:"GJ402692054F",
      roadPaper:{beatPlateRoad:"KAYHpykIQpzEIUhWkOYlCNKQpDlIUhGMoQpCkIABQaCgwA=="},
    }]);
    expect(hall[0].round).toBe(hall[0].results.length);
    expect(hall[0].round).toBeGreaterThan(0);
  });
  it("語系物件要解成官方桌名與荷官名，不能出現 [object Object]",()=>{
    expect(dbPickLang({tc:{languageCode:"tc",content:"秀允"},en:{languageCode:"en",content:"Sooyoon"}})).toBe("秀允");
    expect(dbRoomTitle("极速百家乐","B23")).toBe("极速百家乐B23");
    expect(dbRoomTitle("龙争虎斗04","J36")).toBe("龙争虎斗04");
    const hall=ingestDbPackets([{
      tableId:2641,
      physicsTableNo:"B23",
      gameTypeId:2002,
      dealerName:{en:{content:"Cara"},tc:{content:"Cara"}},
      tableNameLanguageMap:{cn:{content:"极速百家乐B23"},en:{content:"Speed Baccarat B23"}},
    }]);
    expect(hall).toHaveLength(1);
    expect(hall[0].name).toBe("Cara");
    expect(hall[0].roomId).toBe("极速百家乐B23");
  });
});

describe("歐博／DB 啟動網址",()=>{
  it("歐博接受 sessionId 而不是 token",()=>{
    expect(pickLaunchUrl({
      data:{url:"https://www.ab8888.games/entry?sessionId=abc123"},
    },"AB")).toContain("sessionId=abc123");
  });
  it("DB 接受加密 params 並改走 Egret 大廳",()=>{
    expect(pickLaunchUrl({
      data:{game_url:"https://pc.jhui100.com/play?params=xyz"},
    },"DB")).toContain("pc.jhui100.com:2053/egret/hall");
    expect(pickLaunchUrl({
      data:{game_url:"https://pc.jhui100.com/play?params=xyz"},
    },"DB")).toContain("params=xyz");
  });
  it("已有官方 params／sessionId 才算授權可用",()=>{
    expect(vendorLaunchIsReady("AB","https://www.ab8888.games:8888/")).toBe(false);
    expect(vendorLaunchIsReady("AB","https://www.ab8888.games:8888/?sessionId=abc")).toBe(true);
    expect(vendorLaunchIsReady("DB","https://pc.jhui100.com:2053/egret/hall?params=xyz")).toBe(true);
    expect(vendorLaunchIsReady("DB","https://pc.jhui100.com:2053/egret/hall")).toBe(false);
  });
  it("進入歐博要打官方 AB01/login 自動轉點，只有 F5 reuse 才沿用 session",()=>{
    const source=require("node:fs").readFileSync(require("node:path").resolve("server/vendor-ab-proxy.ts"),"utf8");
    expect(source).toContain("reuse === true");
    expect(source).toContain("needLogin");
    expect(source).toContain("fetchVendorLaunchUrl");
    expect(source).toContain("進入平台走官方 AB01/login");
  });
  it("已是 Egret 大廳的網址不改寫",()=>{
    expect(preferDbVueUrl("https://pc.jhui100.com:2053/egret/hall?params=abc")).toBe("https://pc.jhui100.com:2053/egret/hall?params=abc");
  });
  it("DB 手機沿用官方 Mobile 網址，不改寫成電腦 Egret 大廳",()=>{
    const mobile=pickLaunchUrl({
      data:{game_url:"https://m.example-cdn.com/h5/index.html?params=xyz"},
    },"DB","Mobile");
    expect(mobile).toContain("m.example-cdn.com/h5/index.html");
    expect(mobile).toContain("params=xyz");
    expect(mobile).not.toContain("egret/hall");
    expect(pickLaunchUrl({
      data:{game_url:"https://pc.jhui100.com/play?params=xyz"},
    },"DB","Mobile")).toContain("/h5/");
    expect(pickLaunchUrl({
      data:{game_url:"https://pc.jhui100.com/play?params=xyz"},
    },"DB","Mobile")).not.toContain("/egret/hall");
  });
  it("DB 手機 proxy 路徑不強制加上 /egret",()=>{
    expect(resolveDbProxyPathname("/h5/index.html","Mobile")).toBe("/h5/index.html");
    expect(resolveDbProxyPathname("/api/vendor/db/upstream/h5/index.html","Mobile")).toBe("/h5/index.html");
    expect(resolveDbProxyPathname("/","Mobile")).toBe("/");
  });
  it("DB proxy 入口維持官方 /egret 路徑，並還原 Vue 誤加的前綴",()=>{
    expect(resolveDbProxyPathname("/egret/hall")).toBe("/egret/hall");
    expect(resolveDbProxyPathname("/egret/libs/live-sdk/live-sdk.min.js")).toBe("/egret/libs/live-sdk/live-sdk.min.js");
    expect(resolveDbProxyPathname("/api/vendor/db/upstream/egret/hall")).toBe("/egret/hall");
    expect(resolveDbProxyPathname("/egret/api/vendor/db/upstream/egret/hall")).toBe("/egret/hall");
    expect(sanitizeDbUpstreamSearch("?params=abc&signature=s&ttl=1&mtProxySid=deadbeef")).toBe("?params=abc&signature=s&ttl=1");
    expect(sanitizeDbUpstreamSearch("?mtProxySid=x")).toBe("");
    expect(sanitizeDbUpstreamSearch("?params=h6so+K4O/5k&signature=s&mtProxySid=sid")).toBe("?params=h6so+K4O/5k&signature=s");
  });
  it("DB chrome cache 收得下大廳 JS，路徑對得上就能回",()=>{
    const body=Buffer.from("window.__DB_INDEX__=1;");
    rememberDbChromeResponse("https://pc.jhui100.com:2053/egret/js/index-GH5N.release.js?v=1",200,"application/javascript",body);
    expect(readDbChromeResponse("https://pc.jhui100.com:2053/egret/js/index-GH5N.release.js")?.body.toString()).toBe("window.__DB_INDEX__=1;");
  });
  it("前景 cookie 對得上才視為 DB 遊戲頁佔用",()=>{
    const sid="43b2bb4e-e5b1-4c35-a6c3-c8da09f82a18";
    expect(hasDbForegroundCookie(`mt_db_proxy_sid=${sid}; other=1`, sid)).toBe(true);
    expect(hasDbForegroundCookie("mt_db_proxy_sid=other", sid)).toBe(false);
    expect(hasDbForegroundCookie(undefined, sid)).toBe(false);
  });
});
