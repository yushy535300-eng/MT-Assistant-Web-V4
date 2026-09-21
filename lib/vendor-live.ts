export type VendorKind="AB"|"DB";
export type VendorRoadResult="莊"|"閒"|"和";
export type VendorTableData={
  id:string;apiId:string;game:string;name:string;players:string;countdown?:number;countdownUpdatedAt?:number;
  roomId?:string;tableBadge?:string;shoe:string;round:number;banker:number;player:number;tie:number;
  results:VendorRoadResult[];trend:string;live?:boolean;dealerPhoto?:string;streamUrl?:string;
  lastUpdated?:number;lastResultKey?:string;poker?:string;category?:string;
};
type Callbacks={onTables:(v:VendorTableData[])=>void;onStatus?:(s:string,m?:string)=>void;onEvent?:(m:string)=>void;onPnl?:(v:number|null)=>void;onSettlement?:(v:{pnl:number;tableId?:string})=>void};

export async function connectVendorLive(
  kind:VendorKind,
  gameUrl:string,
  sessionId:string,
  cb:Callbacks,
  auth?:{platform:"TZ"|"OFA";platformToken:string;resumeHall?:boolean;restart?:boolean},
){
  let closed=false;
  let source:EventSource|null=null;
  let host="";
  let retries=0;
  const payload=(resumeHall:boolean,restart:boolean)=>JSON.stringify({
    kind,gameUrl,sessionId,platform:auth?.platform,platformToken:auth?.platformToken,restart,
    resumeHall,
  });
  const bind=(next:EventSource)=>{
    next.addEventListener("status",(e:any)=>{try{const x=JSON.parse(e.data);if(x?.status==="connected")retries=0;cb.onStatus?.(x.status,x.message)}catch{}});
    next.addEventListener("tables",(e:any)=>{try{const x=JSON.parse(e.data);if(Array.isArray(x))cb.onTables(x)}catch{}});
    next.addEventListener("pnl",(e:any)=>{try{const x=JSON.parse(e.data);cb.onPnl?.(typeof x==="number"?x:null)}catch{}});
    next.addEventListener("settlement",(e:any)=>{try{cb.onSettlement?.(JSON.parse(e.data))}catch{}});
    next.addEventListener("event",(e:any)=>{try{cb.onEvent?.(JSON.parse(e.data)?.message||"")}catch{}});
    next.onerror=()=>{
      if(closed)return;
      if(next.readyState===EventSource.CONNECTING){
        cb.onStatus?.("connecting",`${kind} 即時資料重連中`);
        return;
      }
      if(next.readyState!==EventSource.CLOSED)return;
      next.close();
      if(source===next)source=null;
      retries+=1;
      if(retries>8){
        cb.onStatus?.("error",`${kind} 即時資料暫時中斷`);
        return;
      }
      cb.onStatus?.("connecting",`${kind} 即時資料重連中`);
      setTimeout(()=>{void boot(false)},Math.min(8000,1000*retries));
    };
  };
  const boot=async(initial=false)=>{
    if(closed)return;
    try{
      const response=await fetch("/api/vendor/start",{method:"POST",headers:{"Content-Type":"application/json"},body:payload(initial && !!auth?.resumeHall, initial && !!auth?.restart)});
      const data=await response.json().catch(()=>null);
      if(!response.ok||!data?.ok)throw new Error(data?.error||`${kind} 啟動失敗`);
      host=String(data?.host||host||"");
      if(data?.paused)cb.onStatus?.("connected",`${kind} 遊戲頁同步中`);
      if(closed)return;
      source?.close();
      source=new EventSource(`/api/vendor/stream?kind=${kind}&sessionId=${encodeURIComponent(sessionId)}`);
      bind(source);
    }catch(error){
      if(closed)return;
      if(initial)throw error;
      retries+=1;
      if(retries>8){
        cb.onStatus?.("error",error instanceof Error?error.message:`${kind} 即時資料暫時中斷`);
        return;
      }
      cb.onStatus?.("connecting",`${kind} 即時資料重連中`);
      setTimeout(()=>{void boot(false)},Math.min(8000,1000*retries));
    }
  };
  await boot(true);
  return{
    get host(){return host},
    close(){
      closed=true;
      source?.close();
      source=null;
      return fetch("/api/vendor/stop",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,sessionId})}).catch(()=>{});
    },
  };
}
