import type { Response } from "express";
import { startVendorBrowserTransport, type VendorBrowserTransport } from "./vendor-chromium";
import { fetchVendorLaunchUrl } from "./vendor-launch";
import { abPnlFromPacket, abReportQueryRange } from "../lib/ab-report";
import { abPlayTableUpdate, abSeatedIdsMatch, abSettleTableIds } from "../lib/ab-play";
import { removePersistedVendor, upsertPersistedVendor } from "./vendor-persist";

export type VendorKind = "AB" | "DB";
type Road = "莊" | "閒" | "和";
export type VendorTable = {
  id:string; apiId:string; game:"百家樂"; name:string; players:string;
  countdown?:number; countdownUpdatedAt?:number; roomId?:string; tableBadge?:string;
  shoe:string; round:number; banker:number; player:number; tie:number; results:Road[];
  trend:string; live:boolean; dealerPhoto?:string; streamUrl?:string; lastUpdated:number;
  lastResultKey?:string; poker?:string; category:string;
};
type Sink=Pick<Response,"write">;

const relays=new Map<string,VendorRelay>();
const abGameForeground=new Set<string>();
export function setAbGameForeground(sessionId:string,on:boolean){
  const id=String(sessionId||"");
  if(!id)return;
  if(on)abGameForeground.add(id);else abGameForeground.delete(id);
}
export function isAbGameForeground(sessionId:string){
  return abGameForeground.has(String(sessionId||""));
}
const n=(v:any)=>{const x=Number(v);return Number.isFinite(x)?x:0};
export function dbPickLang(value:any):string{
  if(value==null||value===false)return"";
  if(typeof value==="number"||typeof value==="boolean")return String(value);
  if(typeof value==="string")return value.trim();
  if(Array.isArray(value)){
    for(const item of value){const s=dbPickLang(item);if(s)return s}
    return"";
  }
  if(typeof value!=="object")return"";
  if(typeof value.content==="string"&&value.content.trim())return value.content.trim();
  const prefer=["tc","cn","zh_TW","zh-TW","zh_CN","zh-CN","zh","zh-Hans","zh-Hant","en"];
  for(const key of prefer){
    if(Object.prototype.hasOwnProperty.call(value,key)){
      const s=dbPickLang(value[key]);
      if(s)return s;
    }
  }
  for(const nested of Object.values(value)){
    const s=dbPickLang(nested);
    if(s)return s;
  }
  return"";
}
const text=(...v:any[])=>{
  for(const x of v){
    if(x===undefined||x===null)continue;
    const s=typeof x==="object"?dbPickLang(x):String(x).trim();
    if(s&&s!=="[object Object]")return s;
  }
  return"";
};
export function dbRoomTitle(tableTitle:string,hallNo:string){
  const title=String(tableTitle||"").trim();
  const hall=String(hallNo||"").trim();
  if(title&&hall&&title.includes(hall))return title;
  if(title&&hall&&/百家乐|百家樂/.test(title)&&title.length<12&&!title.includes(hall))return `${title}${hall}`;
  return title||hall||"";
}
const count=(results:Road[])=>results.reduce((a,r)=>(a[r]++,a),{"莊":0,"閒":0,"和":0} as Record<Road,number>);

export function abRoad(code:any):Road|null{
  const s=String(code??"");
  if(!/^\d{3}/.test(s))return null;
  const banker=n(s[1]),player=n(s[2]);
  return banker===player?"和":banker>player?"莊":"閒";
}
export function abRank(card:any){
  const s=String(card??""); if(!/^\d{3}$/.test(s))return 0;
  const rank=n(s.slice(1)); return rank>=10?10:rank;
}
export function abFace(card:any){
  const s=String(card??"");
  if(s==="-1"||s==="0"||s==="")return "";
  if(!/^\d{3}$/.test(s)){
    const t=s.trim().toUpperCase();
    if(["A","J","Q","K"].includes(t))return t;
    const rank=n(t); if(rank===1)return "A"; if(rank>=2&&rank<=10)return String(rank);
    if(rank===11)return "J"; if(rank===12)return "Q"; if(rank===13)return "K";
    return "";
  }
  const rank=n(s.slice(1));
  if(rank===1)return "A";
  if(rank===11)return "J";
  if(rank===12)return "Q";
  if(rank===13)return "K";
  if(rank>=2&&rank<=10)return String(rank);
  return "";
}
export function abPoker(raw:any){
  const grid=abCardGrid(raw); if(!grid)return undefined;
  const side=(x:any[])=>x.map(abFace).filter(Boolean).slice(0,3).join("-");
  const player=side(grid[0]),banker=side(grid[1]);
  return player||banker?JSON.stringify({player,banker}):undefined;
}
function abLooksLikeCard(value:any){
  const s=String(value??"").trim();
  if(!s||s==="-1"||s==="-2"||s==="0")return false;
  return /^\d{3}$/.test(s) || /^(?:[Aa]|[Jj]|[Qq]|[Kk]|10|[1-9])$/.test(s);
}
export function abCardGrid(raw:any):any[][]|null{
  if(!raw)return null;
  if(typeof raw==="string"){
    const trimmed=raw.trim();
    if((trimmed.startsWith("{")||trimmed.startsWith("["))){
      try{return abCardGrid(JSON.parse(trimmed))}catch{return null}
    }
    return null;
  }
  if(Array.isArray(raw)&&raw.length>=2&&Array.isArray(raw[0])&&Array.isArray(raw[1])){
    const baccaratRows=raw.filter((row)=>Array.isArray(row)&&row.length<=3);
    const rows=baccaratRows.length>=2?baccaratRows.slice(0,2):raw;
    // HAR B201 pushRawCards: B[0] is banker, B[1] is player (first cards always land on B[1]).
    const banker=rows[0].filter(abLooksLikeCard);
    const player=rows[1].filter(abLooksLikeCard);
    if(player.length||banker.length)return [player,banker];
  }
  if(raw&&typeof raw==="object"){
    const player=raw.player??raw.Player??raw.P??raw.idle;
    const banker=raw.banker??raw.Banker??raw.B??raw.bank;
    if(Array.isArray(player)||Array.isArray(banker)){
      return [Array.isArray(player)?player:[],Array.isArray(banker)?banker:[]];
    }
  }
  return null;
}
export function abCategory(code:any){
  return ({101:"一般",103:"快速",104:"免佣",110:"保險",111:"VIP"} as any)[n(code)]||"其他";
}
export function abHandRound(value:any, fallback=0){
  const pick=(x:any)=>{
    const v=n(x);
    return Number.isFinite(v)&&v>0&&v<=200?v:0;
  };
  return pick(value)||pick(fallback)||0;
}
export function abDealerName(value:any){
  const s=text(value);
  const stripped=s.replace(/_\d+$/,"");
  return stripped||s;
}
export function abHands(raw:any){
  const grid=abCardGrid(raw); if(!grid)return null;
  const side=(x:any[])=>x.map(abRank).filter((v)=>v>0).slice(0,3);
  const player=side(grid[0]),banker=side(grid[1]);
  if(player.length<2||banker.length<2)return null;
  const point=(cards:number[])=>cards.reduce((s,v)=>s+(v>=10?0:v),0)%10;
  return {player,banker,playerPoint:point(player),bankerPoint:point(banker)};
}
export function abRoadFromCards(raw:any):Road|null{
  const hands=abHands(raw);if(!hands)return null;
  const {player,banker,playerPoint,bankerPoint}=hands;
  if(playerPoint>=8||bankerPoint>=8)return playerPoint===bankerPoint?"和":playerPoint>bankerPoint?"閒":"莊";
  const playerDraw=playerPoint<=5;
  if(playerDraw&&player.length<3)return null;
  const third=playerDraw?(player[2]>=10?0:player[2]):-1;
  let bankerDraw=false;
  if(!playerDraw)bankerDraw=bankerPoint<=5;
  else if(bankerPoint<=2)bankerDraw=true;
  else if(bankerPoint===3)bankerDraw=third!==8;
  else if(bankerPoint===4)bankerDraw=third>=2&&third<=7;
  else if(bankerPoint===5)bankerDraw=third>=4&&third<=7;
  else if(bankerPoint===6)bankerDraw=third===6||third===7;
  if(bankerDraw&&banker.length<3)return null;
  return playerPoint===bankerPoint?"和":playerPoint>bankerPoint?"閒":"莊";
}
export function dbCategory(value:any){
  const s=String(value??"");
  if(/極速|終極|speedy|ultimate|fast/i.test(s))return"極速";
  if(/完美|perfect/i.test(s))return"完美";
  if(/共贏|共享|cowin|co-win|share/i.test(s))return"共享";
  if(/包桌|private/i.test(s))return"包桌";
  if(/電投|electronic/i.test(s))return"電投";
  if(/經典|classic|一般|baccarat|百家/i.test(s))return"經典";
  return"";
}
const DB_BACCARAT_CATEGORIES:Record<number,string>={2002:"極速",2001:"經典",2003:"完美",2004:"共享",2005:"包桌",2038:"電投"};
export function dbBaccaratCategory(gameTypeId:any){return DB_BACCARAT_CATEGORIES[n(gameTypeId)]||""}
export function dbParseMaybe(value:any):any{
  if(typeof value!=="string")return value;
  const trimmed=value.trim();
  if(!(trimmed.startsWith("{")||trimmed.startsWith("[")))return value;
  try{return dbParseMaybe(JSON.parse(trimmed))}catch{return value}
}
export function dbFlattenPacket(root:any){
  if(!root||typeof root!=="object"||Array.isArray(root))return root;
  const json=dbParseMaybe(root.jsonData);
  const fromJson=json&&typeof json==="object"&&!Array.isArray(json)?json:{};
  const data=dbParseMaybe(fromJson.data??root.data);
  const fromData=data&&typeof data==="object"&&!Array.isArray(data)?data:{};
  const inner=dbParseMaybe((fromData as any).data);
  const fromInner=inner&&typeof inner==="object"&&!Array.isArray(inner)?inner:{};
  const merged:any={...root,...fromJson,...fromData,...fromInner};
  const gid=fromInner.gameTypeId??fromData.gameTypeId??fromJson.gameTypeId;
  if(gid!=null&&n(gid)!==2013)merged.gameTypeId=gid;
  else if(n(merged.gameTypeId)===2013)delete merged.gameTypeId;
  return merged;
}
export function dbCardFace(num:any){
  const x=n(num); if(x<=0)return"";
  const rank=((x-1)%13)+1;
  if(rank===1)return"A"; if(rank===11)return"J"; if(rank===12)return"Q"; if(rank===13)return"K";
  return String(rank);
}
export function dbCollectRoundCards(merged:any){
  const byKey=new Map<string,any>();
  const lists=[merged?._draws,merged?.currentRoundExtInfos,merged?.currentRoundExtInfo];
  for(const list of lists){
    if(!Array.isArray(list))continue;
    for(const info of list){
      if(info==null||info.cardNumber==null||info.cardOwner==null)continue;
      byKey.set(`${n(info.cardOwner)}:${n(info.ownerIndex??info.cardIndex)}`,info);
    }
  }
  return [...byKey.values()];
}
export function dbPoker(merged:any){
  const infos=dbCollectRoundCards(merged);
  if(!infos.length)return undefined;
  const player:string[]=[],banker:string[]=[];
  for(const info of infos){
    const face=dbCardFace(info?.cardNumber); if(!face)continue;
    const slot=Math.max(0,n(info?.ownerIndex??info.cardIndex)-1);
    if(n(info?.cardOwner)===0)player[slot]=face; else banker[slot]=face;
  }
  const p=player.filter(Boolean).join("-"),b=banker.filter(Boolean).join("-");
  return p||b?JSON.stringify({player:p,banker:b}):undefined;
}
export function dbRoundNumber(merged:any, results:Road[]){
  const idx=n(merged?.bootIndex);
  if(idx>0)return idx;
  const named=n(merged?.roundCount??merged?.roundIndex??merged?.gmRound);
  if(named>0&&named<400)return named;
  return Array.isArray(results)?results.length:0;
}
export function dbHasBeatPlate(value:any){
  const encoded=value?.roadPaper?.beatPlateRoad||value?.beatPlateRoad||value?.roadPaper?.beadPlateRoad;
  return typeof encoded==="string"&&encoded.length>0;
}
export function dbResolveCategory(value:any){
  const rawId=value?.gameTypeId??value?.gameTypeID??value?.game_type_id??value?.gameType?.id??value?.gameType?.gameTypeId??value?.tableTypeId;
  const typeId=n(rawId);
  if(typeId===2013)return dbCategory(text(value?.gameTypeName,value?.gameType?.name,value?.gameName));
  const fromId=dbBaccaratCategory(rawId);
  if(fromId)return fromId;
  if(typeId)return"";
  const named=dbCategory(text(value?.gameTypeName,value?.gameType?.name,value?.gameName,value?.tableName,value?.name));
  if(named)return named;
  if(dbHasBeatPlate(value))return"經典";
  return"";
}
const DB_WS_JSON_HINT=/(gameTableMap|protocolId|jsonData|roadPaper|beatPlateRoad|currentRoundExtInfos|currentRoundExtInfo|bootIndex|"tableId"|cardNumber)/;
export function dbExtractWsJson(raw:Buffer|Uint8Array|number[]|string, requireHint=false){
  const buf=typeof raw==="string"?Buffer.from(raw,"utf8"):Buffer.isBuffer(raw)?raw:Buffer.from(raw as any);
  const text=buf.toString("utf8");
  const start=text.indexOf("{");
  if(start<0)return null;
  const slice=text.slice(start).trim();
  if(requireHint&&!DB_WS_JSON_HINT.test(slice))return null;
  try{return JSON.parse(slice)}catch{return null}
}
export function ingestDbPackets(packets:any[]){
  const raw=new Map<string,any>();
  const map=new Map<string,VendorTable>();
  for(const packet of packets)applyDbPacket(packet,raw,map);
  return [...map.values()];
}
function dbTableId(value:any,forcedId?:string){
  const candidates=[value?.tableId,value?.table_id,value?._tableId,forcedId];
  for(const candidate of candidates){
    const id=text(candidate);
    if(/^\d+$/.test(id))return id;
  }
  return text(value?.physicsTableNo,value?.virtualTableNo,forcedId);
}
function applyDbPacket(root:any, dbRaw:Map<string,any>, map:Map<string,VendorTable>, onSkip?:(msg:string)=>void){
  if(!root||typeof root!=="object")return false;
  if(root.__binary){
    const bytes=Array.isArray(root.__binary)?Buffer.from(root.__binary):Buffer.isBuffer(root.__binary)?root.__binary:null;
    const parsed=bytes?dbExtractWsJson(bytes):null;
    if(!parsed)return false;
    root=parsed;
  }
  let changed=false;
  const save=(value:any,forcedId?:string)=>{
    if(!value||typeof value!=="object")return;
    const id=dbTableId(value,forcedId);
    if(!id||id==="undefined")return;
    const previousRaw=dbRaw.get(id)||{};
    const incomingType=n(value.gameTypeId);
    const keepType=(!incomingType||incomingType===2013)&&previousRaw.gameTypeId!=null&&n(previousRaw.gameTypeId)!==2013;
    const roundChanged=value.roundId!=null&&previousRaw.roundId!=null&&String(value.roundId)!==String(previousRaw.roundId);
    const incomingExt=Array.isArray(value.currentRoundExtInfos)?value.currentRoundExtInfos:Array.isArray(value.currentRoundExtInfo)?value.currentRoundExtInfo:null;
    const keepExt=roundChanged?[]:(!incomingExt||!incomingExt.length?(previousRaw.currentRoundExtInfos||previousRaw.currentRoundExtInfo||[]):incomingExt);
    const draws=roundChanged?[]:[...(previousRaw._draws||[])];
    if(value.cardNumber!=null&&value.cardOwner!=null)draws.push({cardNumber:value.cardNumber,cardOwner:value.cardOwner,ownerIndex:value.ownerIndex,cardIndex:value.cardIndex});
    if(Array.isArray(keepExt))for(const info of keepExt){
      if(info?.cardNumber!=null&&info?.cardOwner!=null)draws.push(info);
    }
    const merged={
      ...previousRaw,
      ...value,
      gameTypeId:keepType?previousRaw.gameTypeId:value.gameTypeId??previousRaw.gameTypeId,
      tableOnline:{...(previousRaw.tableOnline||{}),...(value?.tableOnline||{})},
      roadPaper:{...(previousRaw.roadPaper||{}),...(value?.roadPaper||{}),...(typeof value?.data==="object"&&value.data?.beatPlateRoad?value.data:{})},
      gameType:{...(previousRaw.gameType||{}),...(value?.gameType||{})},
      currentRoundExtInfos:keepExt,
      bootIndex:n(value.bootIndex)||n(previousRaw.bootIndex)||undefined,
      _draws:draws,
    };
    dbRaw.set(id,merged);
    const category=dbResolveCategory(merged);
    if(!category){
      onSkip?.(`DB 桌略過｜id=${id}｜gameTypeId=${text(merged.gameTypeId,merged.gameType?.id)}｜keys=${Object.keys(merged).slice(0,12)}`);
      return;
    }
    const old=map.get(id);
    let rr=dbDecodeBeatPlate(merged.roadPaper?.beatPlateRoad||merged.beatPlateRoad||merged.roadPaper?.beadPlateRoad);
    if(!rr.length)rr=dbDecodeBeatPlate(merged.roadPaper?.beatPlateRoad2||merged.beatPlateRoad2);
    if(!rr.length&&Array.isArray(merged.results))rr=merged.results.map((x:any)=>{
      const z=String(x?.result??x?.winner??x?.code??x).toLowerCase();
      if(z.includes("bank")||z==="1"||z==="莊")return"莊";if(z.includes("play")||z==="0"||z==="閒")return"閒";if(z.includes("tie")||z==="2"||z==="和")return"和";return null;
    }).filter(Boolean) as Road[];
    if(!rr.length&&old)rr=old.results;
    const summary=Array.isArray(merged.bootReport?.items)?merged.bootReport.items:[];
    const summaryCount=(point:number,fallback:number)=>n(summary.find((x:any)=>n(x?.betPointId)===point)?.winCount??fallback);
    const counted=count(rr);
    const serverTime=n(merged.serverTime),endTime=n(merged.countdownEndTime);
    const calculatedCountdown=endTime&&serverTime?Math.max(0,Math.ceil((endTime-serverTime)/1000)):0;
    const poker=roundChanged?dbPoker(merged):(dbPoker(merged)||old?.poker);
    const dealer=text(merged.dealerName,merged.dealer?.name,merged.dealer?.nickName,merged.dealerNameLanguageMap,merged.anchorNameMap,old?.name);
    const tableTitle=text(merged.tableNameLanguageMap,merged.tableName);
    const typeName=text(merged.gameTypeName,merged.gameType?.name);
    const hallNo=text(merged.physicsTableNo,merged.virtualTableNo);
    const name=dealer&&dealer!=="[object Object]"?dealer:(old?.name&&old.name!=="[object Object]"?old.name:"—");
    const roomId=dbRoomTitle(tableTitle||typeName,hallNo)||old?.roomId||hallNo||id;
    const countdown=n(calculatedCountdown||merged.countDown||merged.countdown||merged.betCountDown||old?.countdown);
    map.set(id,{id:`DB-${hallNo||id}`,apiId:id,game:"百家樂",name,players:text(merged.tableOnline?.onlineNumber,merged.onlineCount,old?.players,"—"),countdown,countdownUpdatedAt:old&&n(old.countdown)===countdown?old.countdownUpdatedAt:Date.now(),roomId,tableBadge:hallNo||id,shoe:text(merged.bootNo,merged.newBootNo,merged.shoeId,old?.shoe,"—"),round:dbRoundNumber(merged,rr)||old?.round||0,banker:summaryCount(3001,counted.莊),player:summaryCount(3002,counted.閒),tie:summaryCount(3003,counted.和),results:rr,trend:"",live:true,dealerPhoto:text(merged.dealerPic,merged.dealerPicTable,merged.phonePicTable,old?.dealerPhoto)||undefined,poker,lastUpdated:Date.now(),category});
    changed=true;
  };
  const visit=(value:any,depth=0)=>{
    if(value==null||depth>12)return;
    if(typeof value==="string"){
      const trimmed=value.trim();if(!trimmed||!(trimmed.startsWith("{")||trimmed.startsWith("[")))return;
      try{visit(JSON.parse(trimmed),depth+1)}catch{}return;
    }
    if(Array.isArray(value)){for(const item of value.slice(0,3000))visit(item,depth+1);return}
    if(typeof value!=="object")return;
    const flat=dbFlattenPacket(value);
    const mapObj=flat.gameTableMap??flat.tableMap??flat.tablesMap??value.gameTableMap;
    if(mapObj&&typeof mapObj==="object"){
      const entries=Array.isArray(mapObj)?mapObj.map((t:any,i:number)=>[text(t?.tableId,t?.id,i),t]):Object.entries(mapObj);
      for(const [id,table] of entries)save(table,String(id));
    }
    const roads=flat.roadPaperCacheMap??value.roadPaperCacheMap;
    if(roads&&typeof roads==="object"){
      for(const [id,entry] of Object.entries(roads as Record<string,any>)){
        const paper=entry?.data&&typeof entry.data==="object"?entry.data:entry;
        save({tableId:entry?.tableId??id,roadPaper:paper},String(id));
      }
    }
    if(flat.tableId!=null||flat.table_id!=null||flat._tableId!=null)save(flat);
    else if(value.tableId!=null||value.table_id!=null||value._tableId!=null)save(value);
    for(const child of Object.values(value).slice(0,500))visit(child,depth+1);
  };
  visit(root);
  return changed;
}
export function dbDecodeBeatPlate(encoded:any):Road[]{
  if(typeof encoded!=="string"||!encoded)return[];
  try{
    const bytes=Buffer.from(encoded,"base64");
    const bits=[...bytes].map(v=>v.toString(2).padStart(8,"0")).join("");
    let pointer=0;const take=(size:number)=>{const value=parseInt(bits.slice(pointer,pointer+size),2);pointer+=size;return value};
    take(8);const rows=take(8),columns=take(8),total=rows*columns;
    if(!rows||!columns||total>5000)return[];
    const roads:Road[]=[];
    for(let index=0;index<total&&pointer+5<=bits.length;index++){
      const occupied=take(1);
      if(!occupied){take(4);continue}
      const result=take(2);take(2); // pair bits are not needed by the main-page road.
      if(result===0)roads.push("閒");
      else if(result===1||result===3)roads.push("莊"); // result 3 is banker-six.
      else if(result===2)roads.push("和");
    }
    return roads;
  }catch{return[]}
}

class VendorRelay{
  private clients=new Set<Sink>(); private map=new Map<string,VendorTable>();
  private dbRaw=new Map<string,any>();
  private transport:VendorBrowserTransport|null=null; private status="connecting"; private message="啟動中";
  private pnl:number|null=null; private stopped=false; private lastTouch=Date.now();
  private pausedForGame=false; private startJob:Promise<void>|null=null;
  private resumeTimer:ReturnType<typeof setTimeout>|null=null;
  private objectCount=0; private lastLoggedTableCount=0;
  private emitQueued=false; private emitTimer:ReturnType<typeof setTimeout>|null=null;
  private emptyTimer:ReturnType<typeof setTimeout>|null=null;
  private abPlayIds=new Set<string>();
  private abBetLogTimer:ReturnType<typeof setTimeout>|null=null;
  private dbRecovering=false; private dbAuthAt=0; private dbRecoverCount=0; private dbBlockUntil=0;
  private abRecovering=false; private abAuthAt=0; private abKicked=false;
  constructor(readonly key:string,readonly kind:VendorKind,public gameUrl:string,public launchAuth?:{platform:"TZ"|"OFA";platformToken:string}){}
  isPausedForGame(){return this.pausedForGame}
  isThisAbForeground(){
    return this.kind==="AB" && isAbGameForeground(this.key.split(":")[0]||"");
  }
  noteAbKicked(reason="6008"){
    if(this.kind!=="AB"||this.abKicked)return;
    this.abKicked=true;
    this.event(`AB_SESSION_KICKED｜${reason}`);
    if(this.pausedForGame||this.isThisAbForeground())this.setStatus("connected","遊戲頁同步中");
    else this.setStatus("connecting","歐博被其他登入踢下，正在換新授權");
  }
  consumeAbKicked(){
    const kicked=this.abKicked;
    this.abKicked=false;
    return kicked;
  }
  tableCount(){return this.map.size}
  isDbRateLimited(){return this.kind==="DB"&&Date.now()<this.dbBlockUntil}
  noteDbUpstreamWaf(){
    if(this.kind!=="DB")return;
    if(this.map.size)return;
    if(!this.isDbRateLimited())this.markDbWaf();
  }
  fetchViaChrome(url:string){
    return this.transport?.fetchUrl?.(url) ?? Promise.resolve(null);
  }
  needsHallRecover(){return this.kind==="DB"&&!this.pausedForGame&&!this.map.size&&this.status==="error"&&!this.isDbRateLimited()}
  private clearEmptyWatch(){if(this.emptyTimer){clearTimeout(this.emptyTimer);this.emptyTimer=null}}
  private scheduleEmptyWatch(){
    this.clearEmptyWatch();
    if(this.pausedForGame||this.stopped||this.isThisAbForeground())return;
    if(this.kind!=="DB"){
      this.emptyTimer=setTimeout(()=>{if(!this.stopped&&!this.pausedForGame&&!this.isThisAbForeground()&&!this.map.size)void this.recoverAbHall("empty")},25000);
      this.emptyTimer.unref?.();
      return;
    }
    if(this.isDbRateLimited()){this.scheduleDbUnblockStart();return;}
    this.emptyTimer=setTimeout(()=>{if(!this.stopped&&!this.pausedForGame&&!this.map.size&&!this.transport)void this.recoverDbHall("empty")},22000);
    this.emptyTimer.unref?.();
  }
  private scheduleDbUnblockStart(){
    this.clearEmptyWatch();
    if(this.pausedForGame||this.stopped||this.map.size)return;
    const wait=Math.max(1000,this.dbBlockUntil-Date.now());
    this.emptyTimer=setTimeout(()=>{if(!this.stopped&&!this.pausedForGame&&!this.map.size&&!this.transport)void this.recoverDbHall("unblock")},wait);
    this.emptyTimer.unref?.();
  }
  private markDbWaf(){
    this.dbRecoverCount=Math.min(8,this.dbRecoverCount+1);
    this.dbBlockUntil=Date.now()+nextDbWafBlockMs(this.dbRecoverCount);
    if(this.map.size){
      this.setStatus("connected",`DB 已同步 ${this.map.size} 桌`);
      this.event(`大廳限流｜背景仍有 ${this.map.size} 桌，不再重開 Chrome`);
      return;
    }
    this.setStatus("error","DB 官方暫時限流，請稍後再連");
    this.event(`大廳限流｜停 ${Math.round((this.dbBlockUntil-Date.now())/1000)} 秒再試`);
    this.scheduleDbUnblockStart();
  }
  async refreshHallUrl(){
    if(this.kind!=="DB"||!this.launchAuth)return false;
    if(this.isDbRateLimited())return false;
    if(Date.now()-this.dbAuthAt<120000)return false;
    this.dbAuthAt=Date.now();
    this.gameUrl=await fetchVendorLaunchUrl({...this.launchAuth,kind:"DB",device:"Desktop"});
    this.persistRuntime();
    return true;
  }
  async recoverAbHall(reason="empty"){
    if(this.kind!=="AB"||this.pausedForGame||this.isThisAbForeground()||this.stopped||this.abRecovering)return;
    if(!this.abKicked&&this.map.size)return;
    if(this.startJob)return;
    if(!this.abKicked&&Date.now()-this.abAuthAt<35000){
      this.setStatus("connecting","歐博背景連線不穩，正在重試");
      return;
    }
    this.abKicked=false;
    this.abRecovering=true;
    this.abAuthAt=Date.now();
    this.setStatus("connecting","歐博授權失效，正在重連");
    this.event(`歐博恢復｜${reason}`);
    try{
      const current=this.transport;
      this.transport=null;
      if(current)await Promise.resolve(current.stop()).catch(()=>{});
      if(this.launchAuth){
        try{
          this.gameUrl=await fetchVendorLaunchUrl({...this.launchAuth,kind:"AB"});
          this.persistRuntime();
        }catch(authError:any){
          // Render 機房 IP 代打 TZ 常被擋；授權失效時必須請瀏覽器重拿 session。
          if(reason==="6076"||reason==="leave"||/授權|SessionID|6076/i.test(String(reason))){
            this.setStatus("error","歐博授權失效，請重新整理頁面（勿依賴伺服器代打 TZ）");
            this.event(`歐博授權代打失敗｜${authError?.message||authError}`);
            return;
          }
          this.event(`伺服器代打授權失敗，沿用現有網址｜${authError?.message||authError}`);
        }
      }
      if(this.pausedForGame||this.isThisAbForeground()||this.stopped)return;
      await this.start();
    }catch(error:any){
      this.setStatus("connecting",`歐博重連中｜${error?.message||error}`);
      this.scheduleEmptyWatch();
    }finally{this.abRecovering=false}
  }
  async recoverDbHall(reason="empty"){
    if(this.kind!=="DB"||this.pausedForGame||this.stopped||this.map.size||this.dbRecovering)return;
    if(this.isDbRateLimited()){
      this.setStatus("error","DB 官方暫時限流，請稍後再連");
      this.scheduleDbUnblockStart();
      return;
    }
    if(this.transport)return;
    this.dbRecovering=true;
    this.setStatus("connecting","DB 大廳冷卻後重開背景頁");
    this.event(`大廳恢復｜${reason}｜沿用現有授權`);
    try{
      await this.start();
    }finally{this.dbRecovering=false}
  }
  async start(){
    if(this.pausedForGame||this.isThisAbForeground()||this.transport)return;
    if(this.kind==="DB"&&this.isDbRateLimited()){this.scheduleDbUnblockStart();return;}
    if(this.startJob){await this.startJob;return}
    this.startJob=(async()=>{
      if(this.pausedForGame||this.isThisAbForeground()||this.transport)return;
      this.stopped=false;
      this.setStatus("connecting",`${this.kind==="AB"?"歐博":"DB"} 正在啟動背景瀏覽器`);
      let transport:VendorBrowserTransport;
      try{
        transport=await startVendorBrowserTransport({sessionId:this.key,gameUrl:this.gameUrl,label:this.kind,
          shouldAbort:()=>this.pausedForGame||this.isThisAbForeground()||this.stopped||(this.kind==="DB"&&this.isDbRateLimited()&&!this.map.size),
          onLog:m=>{
            this.event(m);
            if(this.kind==="AB"&&!this.map.size&&!this.isThisAbForeground()&&isAbSessionBlockedCapture(m))void this.recoverAbHall("6076");
            if(this.kind==="DB"&&!this.map.size&&isDbHallBlockedCapture(m)){
              if(!this.isDbRateLimited())this.markDbWaf();
              else this.setStatus("error","DB 官方暫時限流，請稍後再連");
            }
          },onObject:o=>this.handle(o),onFailure:m=>{
            if(this.transport===transport)this.transport=null;
            if(this.pausedForGame||this.isThisAbForeground())return;
            if(this.kind==="DB"){
              if(this.isDbRateLimited()){this.scheduleDbUnblockStart();return;}
              void this.recoverDbHall("chrome");
              return;
            }
            this.setStatus("error",m);
            if(this.kind==="AB"&&!this.isThisAbForeground())void this.recoverAbHall("chrome");
          }});
      }catch(error:any){
        const msg=String(error?.message||error||"背景瀏覽器啟動失敗");
        const chromeHint=/找不到 Chrome|Chromium|shared librar|postinstall/i.test(msg)
          ? `${this.kind==="AB"?"歐博":"DB"} 連線失敗：${msg}`
          : `${this.kind==="AB"?"歐博":"DB"} 背景瀏覽器啟動失敗：${msg}`;
        this.setStatus("error",chromeHint);
        this.event(chromeHint);
        throw error;
      }
      if(this.pausedForGame&&this.kind==="DB"){
        this.transport=transport;
        await Promise.resolve(transport.park?.()).catch(()=>{});
        this.setStatus("connected","遊戲頁同步中");
        return;
      }
      if(this.pausedForGame||this.isThisAbForeground()||this.stopped||(this.kind==="DB"&&this.isDbRateLimited()&&!this.map.size)){
        await transport.stop();
        if(this.kind==="DB"&&this.isDbRateLimited()&&!this.map.size){
          this.setStatus("error","DB 官方暫時限流，請稍後再連");
          this.scheduleDbUnblockStart();
        }
        return;
      }
      this.transport=transport;
      this.persistRuntime();
      if(this.map.size){
        this.setStatus("connected",`${this.kind} 已同步 ${this.map.size} 桌`);
      } else {
        this.setStatus("connecting",`${this.kind} 已開啟，等待桌台資料`);
        this.scheduleEmptyWatch();
      }
    })();
    try{await this.startJob}finally{this.startJob=null}
  }
  persistRuntime(){
    const sessionId=this.key.split(":")[0]||"";
    if(!sessionId)return;
    upsertPersistedVendor({sessionId,kind:this.kind,paused:this.pausedForGame,gameUrl:this.gameUrl});
  }
  async pauseTransport(){
    if(this.resumeTimer){clearTimeout(this.resumeTimer);this.resumeTimer=null}
    this.pausedForGame=true;
    this.clearEmptyWatch();
    this.persistRuntime();
    if(this.startJob)await this.startJob.catch(()=>{});
    if(this.kind==="DB" && this.transport){
      await Promise.resolve(this.transport.park?.()).catch(()=>{});
      this.setStatus("connected","遊戲頁同步中");
      this.event("背景瀏覽器保留官方連線，進桌改走已快取資源");
      return;
    }
    const current=this.transport;
    this.transport=null;
    if(current)await Promise.resolve(current.stop()).catch(()=>{});
    this.setStatus("connected","遊戲頁同步中");
    this.event("背景瀏覽器已關閉，改由遊戲頁同步牌面");
  }
  async resumeTransport(){
    if(this.kind==="AB"){
      if(this.resumeTimer)clearTimeout(this.resumeTimer);
      this.pausedForGame=true;
      this.persistRuntime();
      this.resumeTimer=setTimeout(()=>{
        this.resumeTimer=null;
        if(this.stopped||this.isThisAbForeground()){
          this.pausedForGame=true;
          this.persistRuntime();
          return;
        }
        this.pausedForGame=false;
        this.persistRuntime();
        if(this.abKicked)void this.recoverAbHall("leave");
        else void this.ensureRunning();
      }, 2500);
      this.event("遊戲頁關閉後再重開背景歐博，避免 6076");
      return;
    }
    this.pausedForGame=false;
    this.persistRuntime();
    if(this.kind==="DB" && this.transport){
      if(this.map.size)this.setStatus("connected",`DB 已同步 ${this.map.size} 桌`);
      return;
    }
    if(this.isDbRateLimited()){
      this.setStatus(this.map.size?"connected":"error", this.map.size?`DB 已同步 ${this.map.size} 桌`:"DB 官方暫時限流，請稍後再連");
      this.scheduleDbUnblockStart();
      return;
    }
    await this.ensureRunning();
  }
  async ensureRunning(){
    if(this.pausedForGame||this.isThisAbForeground())return;
    if(this.stopped)this.stopped=false;
    if(this.isDbRateLimited()){this.scheduleDbUnblockStart();return;}
    if(!this.transport)await this.start();
  }
  async restart(){
    if(this.pausedForGame||this.isThisAbForeground())return;
    this.transport?.stop();
    this.transport=null;
    this.stopped=false;
    await this.start();
  }
  ingest(root:any){this.handle(root)}
  subscribe(res:Sink){this.lastTouch=Date.now();this.clients.add(res);this.send(res,"status",{status:this.status,message:this.message});this.send(res,"tables",this.tables());this.send(res,"pnl",this.pnl);return()=>{this.clients.delete(res);this.lastTouch=Date.now()}}
  age(){return this.clients.size?0:Date.now()-this.lastTouch}
  stop(){
    this.stopped=true;
    this.pausedForGame=false;
    if(this.resumeTimer){clearTimeout(this.resumeTimer);this.resumeTimer=null}
    this.clearEmptyWatch();
    if(this.abBetLogTimer){clearTimeout(this.abBetLogTimer);this.abBetLogTimer=null}
    this.abPlayIds.clear();
    if(this.emitTimer){clearTimeout(this.emitTimer);this.emitTimer=null}
    this.emitQueued=false;
    const transport=this.transport;
    this.transport=null;
    this.clients.clear();
    const sessionId=this.key.split(":")[0]||"";
    if(sessionId)removePersistedVendor(sessionId,this.kind);
    return Promise.resolve(transport?.stop());
  }
  private send(c:Sink,event:string,data:any){try{c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)}catch{}}
  private broadcast(event:string,data:any){for(const c of this.clients)this.send(c,event,data)}
  private event(message:string){console.log(`[Vendor ${this.kind}][${this.key.slice(0,8)}] ${message}`);this.broadcast("event",{message:`${this.kind} ${message}`})}
  private setStatus(status:string,message:string){
    if(this.status===status&&this.message===message)return;
    this.status=status;this.message=message;console.log(`[Vendor ${this.kind}][${this.key.slice(0,8)}] status=${status}｜${message}`);this.broadcast("status",{status,message});
  }
  private lastTableSig="";
  private tables(){
    return [...this.map.values()].sort((a,b)=>{
      const filled=(x:VendorTable)=>x.results.length?1:0;
      if(filled(a)!==filled(b))return filled(b)-filled(a);
      return a.apiId.localeCompare(b.apiId,undefined,{numeric:true});
    });
  }
  private tableSig(){
    return this.tables().map((t)=>`${t.apiId}:${t.round}:${t.poker||""}:${t.results.length}:${t.countdown??""}`).join("|");
  }
  private emit(){
    if(this.emitQueued)return;
    this.emitQueued=true;
    this.emitTimer=setTimeout(()=>{
      this.emitQueued=false;
      this.emitTimer=null;
      if(!this.map.size)return;
      const sig=this.tableSig();
      if(sig===this.lastTableSig)return;
      this.lastTableSig=sig;
      this.setStatus("connected",`${this.kind} 已同步 ${this.map.size} 桌`);
      this.broadcast("tables",this.tables());
    },80);
  }
  private handle(root:any){
    if(this.stopped||!root||typeof root!=="object")return;
    this.objectCount++;
    if(this.objectCount===1||this.objectCount===10||this.objectCount===100){
      const keys=Object.keys(root).slice(0,20).join(",");
      this.event(`已收到解密物件 ${this.objectCount} 筆｜keys=${keys||"(array)"}`);
    }
    this.lastTouch=Date.now();
    if(this.kind==="AB")this.handleAb(root);else this.handleDb(root);
    if(this.map.size){
      this.dbRecoverCount=0;
      this.clearEmptyWatch();
    }
    const bucket=Math.floor(this.map.size/50);
    if(this.map.size&&bucket!==Math.floor(this.lastLoggedTableCount/50)){
      this.lastLoggedTableCount=this.map.size;
      this.event(`真實百家樂桌解析完成｜${this.map.size} 桌`);
    }
  }
  private abGet(id:any){
    const s=String(id??"");
    if(!s||s==="undefined")return undefined;
    const direct=this.map.get(s);
    if(direct)return {key:s,table:direct};
    for(const [k,t] of this.map){
      if(t.apiId===s||t.id===s||t.tableBadge===s||t.roomId===s)return {key:k,table:t};
    }
    return undefined;
  }
  private abApplyCards(id:any, raw:any, round?:number){
    const hit=this.abGet(id); if(!hit)return false;
    const poker=abPoker(raw);
    const nextRound=abHandRound(round, abHandRound(hit.table.round, hit.table.results.length));
    const newRound=nextRound!==abHandRound(hit.table.round);
    if(!poker&&round==null)return false;
    if(newRound&&!poker){
      this.map.set(hit.key,{...hit.table,round:nextRound,poker:undefined,lastResultKey:undefined,lastUpdated:Date.now()});
      return true;
    }
    const outcome=abRoadFromCards(raw);
    const resultKey=outcome?`${nextRound}:${outcome}`:hit.table.lastResultKey;
    let results=hit.table.results,banker=hit.table.banker,player=hit.table.player,tie=hit.table.tie;
    const settled=!!(outcome&&resultKey!==hit.table.lastResultKey);
    if(settled){
      results=[...hit.table.results,outcome!];
      const c=count(results);banker=c.莊;player=c.閒;tie=c.和;
    }
    this.map.set(hit.key,{...hit.table,round:nextRound,poker:newRound?poker:poker||hit.table.poker,results,banker,player,tie,lastResultKey:resultKey,lastUpdated:Date.now()});
    if(settled&&this.abIsPlayTable(hit.key,hit.table.apiId,hit.table.id))this.scheduleAbBetLogPull();
    return true;
  }
  private abIsPlayTable(...ids:any[]){
    return abSeatedIdsMatch(this.abPlayIds, ids.filter((v)=>v!=null&&v!=="").map(String));
  }
  private applyAbPlayPacket(o:any){
    const update=abPlayTableUpdate(o);
    if(update.leave){
      this.abPlayIds.clear();
      return;
    }
    if(!update.join.length)return;
    this.abPlayIds=new Set(update.join);
    const label=update.join.find((id)=>/[A-Za-z]/.test(id))||update.join[0];
    this.event(`歐博進桌｜${label}`);
  }
  private scheduleAbBetLogPull(){
    if(this.kind!=="AB"||this.stopped)return;
    if(this.abBetLogTimer)clearTimeout(this.abBetLogTimer);
    this.abBetLogTimer=setTimeout(()=>{this.abBetLogTimer=null;void this.pullAbBetLog()},1000);
    this.abBetLogTimer.unref?.();
  }
  private async pullAbBetLog(){
    if(this.kind!=="AB"||this.stopped)return;
    let sid="";
    try{sid=new URL(this.gameUrl).searchParams.get("sessionId")||""}catch{}
    if(!sid)return;
    const range=abReportQueryRange();
    try{
      const res=await fetch("https://www.hnyonyou.net/api-gw/webapi/betLog/records",{
        method:"POST",
        headers:{
          "content-type":"application/json; charset=UTF-8",
          accept:"application/json, text/plain, */*",
          sessionid:sid,
        },
        body:JSON.stringify({c:"",d:"",g:range.g,h:range.h,i:1,j:50}),
      });
      const json=await res.json();
      this.applyAbPnl(json);
    }catch{}
  }
  private applyAbPnl(o:any){
    const next=abPnlFromPacket(o);
    if(next==null||this.pnl===next)return;
    this.pnl=next;
    this.broadcast("pnl",this.pnl);
  }
  private handleAb(o:any){
    this.applyAbPnl(o);
    this.applyAbPlayPacket(o);
    if(abSeatedIdsMatch(this.abPlayIds, abSettleTableIds(o)))this.scheduleAbBetLogPull();
    const cmd=String(o?.c||o?.cmd||o?.method||""); const p=o?.p||o?.payload||o?.data||{};
    if(cmd==="getGameHall"&&Array.isArray(p.D)){
      for(const r of p.D){
        const cat=abCategory(r?.DD);if(cat==="其他")continue;
        const key=String(r.AA);
        const id=text(r?.BB,r?.AA);
        const roads=(r?.WW3?.[0]||[]).map(abRoad).filter(Boolean) as Road[];
        const hallPoker=abPoker(r?.XX)||abPoker(r?.YY)||abPoker(r?.B)||abPoker(r?.HH?.XX)||abPoker(r?.HH?.B);
        const hallRound=abHandRound(r?.HH?.CC);
        const prev=this.map.get(key);
        const prevRound=abHandRound(prev?.round);
        const liveAhead=!!prev&&hallRound>0&&prevRound>=hallRound;
        const results=liveAhead||(prev&&prev.results.length>roads.length)?prev!.results:roads;
        const c=count(results);
        const round=Math.max(prevRound,hallRound,results.length);
        const poker=liveAhead?prev!.poker:hallRound>prevRound?hallPoker:(prev?.poker||hallPoker);
        this.map.set(key,{id,apiId:id,game:"百家樂",name:abDealerName(text(r?.II,prev?.name,"—")),players:"—",countdown:n(r?.HH?.BB),countdownUpdatedAt:Date.now(),roomId:id,tableBadge:key,shoe:text(r?.HH?.AA,r?.shoe,prev?.shoe,"—"),round,banker:c.莊,player:c.閒,tie:c.和,results,trend:"",live:true,streamUrl:r?.Z16?String(r.Z16):prev?.streamUrl,poker,lastUpdated:Date.now(),category:cat,lastResultKey:prev?.lastResultKey});
      }this.emit();return;
    }
    if(cmd==="pushGameStatus"&&Array.isArray(p.A)){
      for(const s of p.A){
        const hit=this.abGet(s.AA)||this.abGet(s.BB);if(!hit)continue;
        const round=abHandRound(s.CC, abHandRound(hit.table.round, hit.table.results.length));
        this.map.set(hit.key,{...hit.table,countdown:n(s.BB),countdownUpdatedAt:Date.now(),round,lastUpdated:Date.now()});
        const cards=s.XX||s.YY||s.B||s.F;
        if(abPoker(cards))this.abApplyCards(hit.key,cards,s.CC);
      }this.emit();return;
    }
    if(cmd==="pushGameTableResults"){
      const hit=this.abGet(p.A??p.AA??p.BB);if(!hit)return;
      const extra=(Array.isArray(p.G)?p.G.flat():[]).map(abRoad).filter(Boolean) as Road[];
      if(!extra.length)return;
      const already=hit.table.results.slice(-extra.length).join(",")===extra.join(",");
      if(already)return;
      const results=[...hit.table.results,...extra];
      const lastResultKey=`${n(p.C)||hit.table.round}:${extra.at(-1)}:${results.length}`;
      const c=count(results);
      this.map.set(hit.key,{...hit.table,results,banker:c.莊,player:c.閒,tie:c.和,shoe:text(p.C,hit.table.shoe),lastResultKey,lastUpdated:Date.now()});
      this.emit();return;
    }
    if(/rawcards|pushrawcards|pushpoker|showcards/i.test(cmd)){
      if(this.abApplyCards(p.A??p.AA??p.BB??p.tableId??p.D,p.B??p.XX??p.cards??p.poker,p.E??p.CC??p.round))this.emit();
      return;
    }
    if(cmd==="pushPayoutInfo"){
      this.abApplyCards(p.D??p.A,p.B??p.XX,p.E);
      this.emit();
      return;
    }
    if(!cmd){
      if(this.abApplyCards(o.A??o.AA??o.tableId,o.B??o.XX??o.cards,o.E??o.round))this.emit();
    }
  }
  private handleDb(root:any){
    const pnlCandidate=root?.totalWinLoss??root?.todayWinLoss??root?.netWinLoss??root?.data?.totalWinLoss??root?.data?.todayWinLoss??root?.data?.netWinLoss;
    if(pnlCandidate!==undefined&&Number.isFinite(Number(pnlCandidate))){this.pnl=Number(pnlCandidate);this.broadcast("pnl",this.pnl)}
    const changed=applyDbPacket(root,this.dbRaw,this.map,this.objectCount<=8?(msg)=>this.event(msg):undefined);
    if(changed)this.emit();
  }
}

export function isAbSessionBlockedCapture(message:string){
  return /\[6076\]|SessionID錯誤|sessionid錯誤|請返回重新嘗試/i.test(String(message||""));
}
export function isDbHallBlockedCapture(message:string){
  return /title=403|http_ratelimit|been blocked|Denied by http/i.test(String(message||""));
}
export function nextDbWafBlockMs(hitCount:number){
  return Math.min(600000, 120000 * Math.max(1, hitCount));
}
export function shouldIgnorePausedVendorStart(resumeHall:boolean,paused:boolean,inGameCookie:boolean){
  return !resumeHall && (paused || inGameCookie);
}
export async function stopOtherVendorRelays(sessionId:string,kind:VendorKind){
  const keep=`${sessionId}:${kind}`;
  const jobs:Promise<any>[]=[];
  for(const [k,r] of [...relays]){
    if(r.kind!==kind||k===keep)continue;
    jobs.push(Promise.resolve(r.stop()));
    relays.delete(k);
  }
  await Promise.all(jobs);
}
export async function adoptPausedVendorRelay(sessionId:string,kind:VendorKind,gameUrl:string,launchAuth?:{platform:"TZ"|"OFA";platformToken:string}){
  const key=`${sessionId}:${kind}`;
  const old=relays.get(key);
  if(old){
    if(launchAuth)old.launchAuth=launchAuth;
    if(gameUrl)old.gameUrl=gameUrl;
    await old.pauseTransport();
    return old;
  }
  const relay=new VendorRelay(key,kind,gameUrl,launchAuth);
  relays.set(key,relay);
  await relay.pauseTransport();
  return relay;
}
export async function startVendorRelay(sessionId:string,kind:VendorKind,gameUrl:string,restart=false,launchAuth?:{platform:"TZ"|"OFA";platformToken:string}){
  const key=`${sessionId}:${kind}`;
  await stopOtherVendorRelays(sessionId,kind);
  const old=relays.get(key);
  if(old){
    if(launchAuth)old.launchAuth=launchAuth;
    if(old.isPausedForGame()||(kind==="AB"&&isAbGameForeground(sessionId)))return old;
    if(gameUrl)old.gameUrl=gameUrl;
    if(restart)void old.restart();
    else void old.ensureRunning();
    return old;
  }
  const relay=new VendorRelay(key,kind,gameUrl,launchAuth);relays.set(key,relay);
  // Keep fire-and-forget so /api/vendor/start still returns quickly and SSE can
  // stream connecting/error. start() itself now sets status=error on Chrome failure.
  void relay.start().catch((e:any)=>{
    console.error(`[Vendor ${kind}] start failed｜${e?.message||e}`);
  });
  return relay;
}
export const getVendorRelay=(sessionId:string,kind:VendorKind)=>relays.get(`${sessionId}:${kind}`);
export function stopVendorRelay(sessionId:string,kind?:VendorKind){
  for(const [k,r] of relays){
    if(!k.startsWith(`${sessionId}:`)||(kind&&r.kind!==kind))continue;
    if(r.isPausedForGame()||(r.kind==="AB"&&isAbGameForeground(sessionId)))continue;
    r.stop();
    relays.delete(k);
  }
}
export function sweepVendorRelays(maxAge=180000){
  let stopped=0;
  for(const [k,r] of relays){
    if(r.isPausedForGame()||(r.kind==="AB"&&isAbGameForeground(k.split(":")[0]||"")))continue;
    if(r.age()>maxAge){r.stop();relays.delete(k);stopped++}
  }
  return stopped;
}
