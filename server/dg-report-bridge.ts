// Runs inside the proxied DG document, before DG registers its socket listeners.
// All requests use the existing authenticated socket. No login or new socket.
export const DG_REPORT_BRIDGE_SCRIPT = String.raw`
let __pnlSocket=null,__pnlBusy=false;
function __pnlBean(value){
  const b=value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
  if(!b)return null;
  let p=0;const out={list:[]};
  const v=()=>{let n=0,k=0,x;do{if(p>=b.length||k>49)throw Error('varint');x=b[p++];n+=(x&127)*Math.pow(2,k);k+=7;}while(x&128);return n;};
  while(p<b.length){const key=v(),f=Math.floor(key/8),w=key&7;
    if(w===0){const n=v();if(f===1)out.cmd=n;else if(f===3)out.codeId=n;else if(f===10)out.type=n;}
    else if(w===2){const len=v(),end=p+len;if(end>b.length)throw Error('length');if(f===12)out.list.push(new TextDecoder().decode(b.subarray(p,end)));p=end;}
    else if(w===1)p+=8;else if(w===5)p+=4;else throw Error('wire');
    if(p>b.length)throw Error('truncated');
  }return out;
}
async function __pnlPoll(){
  const ws=__pnlSocket;if(__pnlBusy||!ws||ws.readyState!==1)return;
  __pnlBusy=true;
  try{const r=await fetch('/api/dg/proxy/report-request',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if(!r.ok)return;const data=await r.json();
    if(data.frame&&ws===__pnlSocket&&ws.readyState===1){const bytes=Uint8Array.from(atob(data.frame),c=>c.charCodeAt(0));NativeWS.prototype.send.call(ws,bytes);}
  }catch{}finally{__pnlBusy=false;}
}
function __pnlReceive(ws,event){
  try{const bean=__pnlBean(event.data);if(!bean)return;
    if(bean.cmd===10086&&bean.codeId===0){__pnlSocket=ws;setTimeout(__pnlPoll,500);}
    // Do not let an assistant-only report overwrite a report the user is viewing.
    if(bean.cmd===13&&bean.type===1&&JSON.stringify(bean.list)==='["","","11","1"]')event.stopImmediatePropagation();
  }catch{}
}
const __pnlTimer=setInterval(__pnlPoll,2000);
window.addEventListener('pagehide',()=>{clearInterval(__pnlTimer);__pnlSocket=null;},{once:true});
`;
