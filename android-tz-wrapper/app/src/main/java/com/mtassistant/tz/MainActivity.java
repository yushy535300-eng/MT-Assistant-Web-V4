package com.mtassistant.tz;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.net.Uri;
import android.webkit.*;
import android.view.*;
import android.widget.FrameLayout;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class MainActivity extends Activity {
    private FrameLayout root;
    private WebView web;
    private WebView dgWeb;
    private static final String APP_URL="https://mt-assistant-web-v3.onrender.com/";
    private static final String TZ_HOST="www.tz6868.cc";

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.rgb(2,10,18));
        getWindow().setNavigationBarColor(Color.rgb(2,10,18));

        root=new FrameLayout(this);
        web=new WebView(this); web.setBackgroundColor(Color.rgb(2,10,18));
        root.addView(web,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        configureWebView(web);
        web.addJavascriptInterface(new NativeBridge(),"NativeBridge");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient(){
            @Override public void onPageFinished(WebView v,String url){ injectNativeHttp(v); }
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){
                UriGuard g=UriGuard.of(r.getUrl().toString());
                if(g.isHttp()) return false;
                return true;
            }
        });
        WebView.setWebContentsDebuggingEnabled(false);
        web.loadUrl(APP_URL);
    }

    private void configureWebView(WebView target){
        WebSettings s=target.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        target.setOverScrollMode(View.OVER_SCROLL_NEVER);
        target.setVerticalScrollBarEnabled(false);
        target.setHorizontalScrollBarEnabled(false);
    }

    private void injectNativeHttp(WebView v){
        String js="(function(){if(window.__MT_TZ_NATIVE)return;window.__MT_TZ_NATIVE=1;window.__httpCbs={};"+
          "window.__nativeHttpDone=function(id,ok,p){var x=window.__httpCbs[id];if(!x)return;delete window.__httpCbs[id];try{var o=JSON.parse(p);ok?x.r(o):x.j(new Error((o&&o.message)||'HTTP error'));}catch(e){ok?x.r(p):x.j(e);}};"+
          "window.Capacitor=window.Capacitor||{};window.Capacitor.Plugins=window.Capacitor.Plugins||{};"+
          "window.Capacitor.Plugins.CapacitorHttp={request:function(o){return new Promise(function(r,j){var id='h'+Date.now()+Math.random();window.__httpCbs[id]={r:r,j:j};NativeBridge.httpRequest(id,JSON.stringify(o));});}};})();";
        v.evaluateJavascript(js,null);
    }

    /**
     * Injected before DG's own index.js. The vendor page still creates its own
     * WebSocket (therefore the browser/WebView supplies the real DG Origin),
     * while we only mirror received binary frames to the outer MT UI.
     */
    private String dgHookScript(){
        return "(function(){"+
          "if(window.__MT_DG_NATIVE_HOOK)return;window.__MT_DG_NATIVE_HOOK=1;"+
          "var NativeWS=window.WebSocket;if(!NativeWS)return;"+
          "function state(s,d){try{DgNativeBridge.onState(String(s||''),String(d||''));}catch(e){}}"+
          "function sendAB(ab){try{var a=new Uint8Array(ab),out='',step=32768;for(var i=0;i<a.length;i+=step){out+=String.fromCharCode.apply(null,a.subarray(i,Math.min(i+step,a.length)));}DgNativeBridge.onBinary(btoa(out));}catch(e){state('bridge_error',e&&e.message||e);}}"+
          "function isDg(u){u=String(u||'');return /(?:kindlestone\\.com|taxyss\\.com|ywjxi\\.com)/i.test(u);}"+
          "function WrappedWS(url,protocols){var ws=(arguments.length>1)?new NativeWS(url,protocols):new NativeWS(url);"+
          "if(isDg(url)){state('socket_create',url);ws.addEventListener('open',function(){state('open',url);});ws.addEventListener('close',function(e){state('close',String((e&&e.code)||0)+' '+String((e&&e.reason)||''));});ws.addEventListener('error',function(){state('error',url);});ws.addEventListener('message',function(e){var d=e.data;if(d instanceof ArrayBuffer){sendAB(d);}else if(typeof Blob!=='undefined'&&d instanceof Blob&&d.arrayBuffer){d.arrayBuffer().then(sendAB).catch(function(){});}});}"+
          "return ws;}"+
          "WrappedWS.prototype=NativeWS.prototype;"+
          "try{Object.defineProperty(WrappedWS,'CONNECTING',{value:NativeWS.CONNECTING});Object.defineProperty(WrappedWS,'OPEN',{value:NativeWS.OPEN});Object.defineProperty(WrappedWS,'CLOSING',{value:NativeWS.CLOSING});Object.defineProperty(WrappedWS,'CLOSED',{value:NativeWS.CLOSED});}catch(e){}"+
          "window.WebSocket=WrappedWS;state('hook','ready');"+
          "})();";
    }

    private boolean isPrivateHost(String host){
        if(host==null)return true;
        String h=host.toLowerCase(Locale.US);
        return h.equals("localhost")||h.endsWith(".localhost")||h.equals("0.0.0.0")||h.equals("::1")||h.startsWith("127.")||h.startsWith("10.")||h.startsWith("192.168.")||h.startsWith("169.254.")||h.matches("^172\\.(1[6-9]|2[0-9]|3[01])\\..*");
    }

    private boolean isSafeDgLaunch(String raw){
        try{
            URL u=new URL(raw);
            if(!"https".equalsIgnoreCase(u.getProtocol())||isPrivateHost(u.getHost()))return false;
            Uri uri=Uri.parse(raw);
            String token=uri.getQueryParameter("token");
            String path=u.getPath()==null?"":u.getPath().toLowerCase(Locale.US);
            return token!=null&&!token.trim().isEmpty()&&path.contains("/ddnewpc/");
        }catch(Exception e){return false;}
    }

    private synchronized void ensureDgWeb(){
        if(dgWeb!=null)return;
        dgWeb=new WebView(this);
        dgWeb.setBackgroundColor(Color.TRANSPARENT);
        configureWebView(dgWeb);
        dgWeb.getSettings().setUserAgentString("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36");
        dgWeb.addJavascriptInterface(new DgBridge(),"DgNativeBridge");
        dgWeb.setWebChromeClient(new WebChromeClient());
        dgWeb.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                String url=request.getUrl().toString();
                String path=request.getUrl().getPath();
                if("GET".equalsIgnoreCase(request.getMethod())&&path!=null&&path.toLowerCase(Locale.US).endsWith("/ddnewpc/index.html")){
                    WebResourceResponse injected=loadInjectedDgIndex(url,request.getRequestHeaders());
                    if(injected!=null)return injected;
                }
                return super.shouldInterceptRequest(view,request);
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon){
                sendDgStateToMain("page",url);
            }
            @Override public void onPageFinished(WebView view,String url){
                // Backup injection. The primary injection is in index.html before index.js.
                view.evaluateJavascript(dgHookScript(),null);
                sendDgStateToMain("page_ready",url);
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){
                if(request.isForMainFrame())sendDgStateToMain("page_error",String.valueOf(error));
            }
        });

        FrameLayout.LayoutParams lp=new FrameLayout.LayoutParams(2,2);
        lp.leftMargin=0; lp.topMargin=0;
        root.addView(dgWeb,lp);
        dgWeb.setAlpha(0.01f); // Attached/running, but invisible to the user.
    }

    private WebResourceResponse loadInjectedDgIndex(String url,Map<String,String> requestHeaders){
        HttpURLConnection c=null;
        try{
            URL u=new URL(url);
            if(!"https".equalsIgnoreCase(u.getProtocol())||isPrivateHost(u.getHost()))return null;
            c=(HttpURLConnection)u.openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(12000);c.setReadTimeout(12000);c.setUseCaches(false);
            c.setRequestProperty("Cache-Control","no-cache");c.setRequestProperty("Pragma","no-cache");
            c.setRequestProperty("Accept-Language","zh-TW,zh;q=0.9");
            c.setRequestProperty("User-Agent",dgWeb.getSettings().getUserAgentString());
            if(requestHeaders!=null){
                String ref=requestHeaders.get("Referer");if(ref!=null)c.setRequestProperty("Referer",ref);
            }
            String cookie=CookieManager.getInstance().getCookie(url);if(cookie!=null)c.setRequestProperty("Cookie",cookie);
            int status=c.getResponseCode();
            if(status<200||status>=300)return null;
            InputStream in=c.getInputStream();String html=readAll(in);
            String injection="<script type=\"text/javascript\">"+dgHookScript()+"</script>";
            int head=html.toLowerCase(Locale.US).indexOf("<head>");
            String modified=head>=0?html.substring(0,head+6)+injection+html.substring(head+6):injection+html;
            Map<String,List<String>> hs=c.getHeaderFields();
            if(hs!=null){List<String> sc=hs.get("Set-Cookie");if(sc!=null)for(String v:sc)CookieManager.getInstance().setCookie(url,v);}
            sendDgStateToMain("inject","DG index hook ready");
            return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream(modified.getBytes(StandardCharsets.UTF_8)));
        }catch(Exception e){
            sendDgStateToMain("inject_error",e.toString());
            return null;
        }finally{if(c!=null)c.disconnect();}
    }

    private void sendDgStateToMain(String state,String detail){
        if(web==null)return;
        runOnUiThread(()->web.evaluateJavascript("window.__MT_DG_NATIVE_STATE&&window.__MT_DG_NATIVE_STATE("+JSONObject.quote(state)+","+JSONObject.quote(detail==null?"":detail)+")",null));
    }

    private void sendDgPacketToMain(String base64){
        if(web==null||base64==null)return;
        runOnUiThread(()->web.evaluateJavascript("window.__MT_DG_NATIVE_PACKET&&window.__MT_DG_NATIVE_PACKET("+JSONObject.quote(base64)+")",null));
    }

    private String readAll(InputStream in)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);return out.toString(StandardCharsets.UTF_8.name());}

    public class DgBridge {
        @JavascriptInterface public void onBinary(String base64){sendDgPacketToMain(base64);}
        @JavascriptInterface public void onState(String state,String detail){sendDgStateToMain(state,detail);}
    }

    public class NativeBridge {
        @JavascriptInterface public void startDg(String gameUrl){
            if(!isSafeDgLaunch(gameUrl)){sendDgStateToMain("page_error","invalid DG launch URL");return;}
            runOnUiThread(()->{ensureDgWeb();try{dgWeb.stopLoading();dgWeb.loadUrl(gameUrl);}catch(Exception e){sendDgStateToMain("page_error",e.toString());}});
        }
        @JavascriptInterface public void stopDg(){
            runOnUiThread(()->{if(dgWeb!=null){try{dgWeb.stopLoading();dgWeb.loadUrl("about:blank");}catch(Exception ignored){}}});
        }
        @JavascriptInterface public void httpRequest(String cb,String optionsJson){
            new Thread(()->{
                boolean ok=false; String payload;
                try{
                    JSONObject o=new JSONObject(optionsJson); URL u=new URL(o.getString("url"));
                    // Native bridge is intentionally locked to TZ login HTTPS only.
                    if(!"https".equalsIgnoreCase(u.getProtocol()) || !TZ_HOST.equalsIgnoreCase(u.getHost()) || !"/api/v1/login".equals(u.getPath())) throw new SecurityException("Blocked native HTTP destination");
                    String method=o.optString("method","POST"); if(!"POST".equalsIgnoreCase(method)) throw new SecurityException("Blocked HTTP method");
                    HttpURLConnection c=(HttpURLConnection)u.openConnection(); c.setRequestMethod("POST"); c.setConnectTimeout(o.optInt("connectTimeout",15000)); c.setReadTimeout(o.optInt("readTimeout",15000)); c.setUseCaches(false); c.setDoOutput(true);
                    JSONObject headers=o.optJSONObject("headers"); if(headers!=null){Iterator<String> it=headers.keys();while(it.hasNext()){String k=it.next();c.setRequestProperty(k,headers.optString(k));}}
                    if(headers==null||!headers.has("Content-Type"))c.setRequestProperty("Content-Type","application/json; charset=utf-8");
                    Object data=o.opt("data"); byte[] body=(data instanceof String?(String)data:String.valueOf(data)).getBytes(StandardCharsets.UTF_8); try(OutputStream os=c.getOutputStream()){os.write(body);}
                    int status=c.getResponseCode(); InputStream in=status>=400?c.getErrorStream():c.getInputStream(); String txt=in==null?"":readAll(in);
                    JSONObject res=new JSONObject();res.put("status",status);try{res.put("data",new JSONTokener(txt).nextValue());}catch(Exception e){res.put("data",txt);}payload=res.toString();ok=status<400;
                }catch(Exception e){try{JSONObject er=new JSONObject();er.put("message",e.toString());payload=er.toString();}catch(Exception x){payload="{\"message\":\"error\"}";}}
                final boolean fok=ok;final String fp=payload;runOnUiThread(()->web.evaluateJavascript("window.__nativeHttpDone("+JSONObject.quote(cb)+","+(fok?"true":"false")+","+JSONObject.quote(fp)+")",null));
            }).start();
        }
    }

    static class UriGuard { final String s; UriGuard(String s){this.s=s;} static UriGuard of(String s){return new UriGuard(s);} boolean isHttp(){return s.startsWith("https://")||s.startsWith("http://");} }

    @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
    @Override protected void onDestroy(){try{if(dgWeb!=null)dgWeb.destroy();}catch(Exception ignored){}try{if(web!=null)web.destroy();}catch(Exception ignored){}super.onDestroy();}
}
