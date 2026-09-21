import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const NORMAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const DG_HOST_RE = /(?:^|\.)(?:kindlestone\.com|taxyss\.com|ywjxi\.com|20299999\.com|dingdangmail\.com)$/i;

export type DgChromiumTransport = { stop: () => void; sendBinary: (data: Buffer) => Promise<boolean> };
export type DgChromiumHooks = {
  sessionId: string;
  gameUrl: string;
  onLog: (message: string) => void;
  onBinary: (data: Buffer) => void;
  onMainUrl?: (url: string) => void;
  onHandshake?: (url: string, status: number) => void;
  onFailure?: (message: string) => void;
};

export type VendorBrowserHooks = {
  sessionId: string;
  gameUrl: string;
  label: "AB" | "DB";
  onLog: (message: string) => void;
  onObject: (value: any) => void;
  onFailure?: (message: string) => void;
};

export type VendorBrowserTransport = { stop: () => void };

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
type RequestMeta = { url: string; type: string; method: string };

function findChromeExecutable() {
  const root = process.cwd();
  const candidates = [
    process.env.DG_CHROME_PATH,
    process.env.CHROME_PATH,
    path.join(root, '.chrome', 'opt', 'google', 'chrome', 'google-chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((x): x is string => !!x);
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return '';
}

function isDgWs(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'wss:' && DG_HOST_RE.test(u.hostname);
  } catch { return false; }
}

function redactUrl(value: string) {
  try {
    const u = new URL(value);
    for (const key of ['token', 'sign', 'auth', 'authorization', 'session', 'sessionId']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return String(value || '')
      .replace(/([?&](?:token|sign|auth|authorization|session|sessionId)=)[^&#\s]+/gi, '$1***')
      .slice(0, 800);
  }
}

function safeText(value: unknown, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function interestingRequest(url: string, type: string) {
  try {
    const u = new URL(url);
    if (DG_HOST_RE.test(u.hostname)) return true;
    if (/game_settings\.json|bundle(?:\.min)?\.js|common(?:\.min)?\.js|\.json(?:$|\?)/i.test(u.pathname + u.search)) return true;
    return ['Document', 'Script', 'XHR', 'Fetch', 'WebSocket'].includes(type);
  } catch { return false; }
}

function cdpRemoteValue(arg: any) {
  if (!arg) return '';
  if (arg.value != null) {
    if (typeof arg.value === 'string') return arg.value;
    try { return JSON.stringify(arg.value); } catch { return String(arg.value); }
  }
  if (arg.unserializableValue != null) return String(arg.unserializableValue);
  if (arg.description != null) return String(arg.description);
  return String(arg.type || '');
}

class CdpClient {
  private ws: any;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: CdpMessage) => void>();
  private openPromise: Promise<void>;

  constructor(private readonly url: string) {
    const NativeWebSocket = (globalThis as any).WebSocket;
    if (!NativeWebSocket) throw new Error('Node WebSocket client unavailable');
    this.ws = new NativeWebSocket(url);
    this.openPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome DevTools connection timeout')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools connection failed')); }, { once: true });
    });
    this.ws.addEventListener('message', (evt: any) => {
      let message: CdpMessage;
      try {
        const raw = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf8');
        message = JSON.parse(raw);
      } catch { return; }
      if (message.id != null) {
        const p = this.pending.get(message.id);
        if (p) {
          clearTimeout(p.timer); this.pending.delete(message.id);
          if (message.error) p.reject(new Error(message.error.message || 'CDP command failed'));
          else p.resolve(message.result || {});
        }
      }
      if (message.method) for (const fn of this.listeners) { try { fn(message); } catch {} }
    });
    this.ws.addEventListener('close', () => {
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Chrome DevTools disconnected')); this.pending.delete(id); }
    });
  }

  async ready() { await this.openPromise; }
  onEvent(fn: (message: CdpMessage) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async send(method: string, params: any = {}, sessionId?: string, timeoutMs = 10000) {
    await this.ready();
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function launchChrome(executable: string, sessionId: string, onLog: (message: string) => void) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `dg-chrome-${sessionId.slice(0, 8)}-`));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=TranslateUI',
    '--disable-blink-features=AutomationControlled',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-TW',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--user-agent=${NORMAL_CHROME_UA}`,
    '--window-size=1280,720',
    'about:blank',
  ];

  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let stderr = '';
  let resolved = false;
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Chromium launch timeout${stderr ? `: ${stderr.slice(-500)}` : ''}`));
    }, 12000);
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString('utf8'); stderr += text;
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/i);
      if (m?.[1] && !resolved) {
        resolved = true; clearTimeout(timer); resolve(m[1]);
      }
    };
    child.stderr.on('data', inspect);
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      if (resolved) return;
      resolved = true; clearTimeout(timer);
      reject(new Error(`Chromium exited before DevTools was ready (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(-500)}` : ''}`));
    });
    child.once('error', err => {
      if (resolved) return;
      resolved = true; clearTimeout(timer); reject(err);
    });
  });
  onLog(`Chromium 已啟動｜pid=${child.pid}｜exe=${executable}`);
  return { child, profile, wsUrl };
}

type LaunchedChrome = Awaited<ReturnType<typeof launchChrome>>;
let warmChrome: LaunchedChrome | null = null;
let warmChromePromise: Promise<LaunchedChrome> | null = null;
let warmChromeTimer: ReturnType<typeof setTimeout> | null = null;

function chromeAlive(chrome: LaunchedChrome | null) {
  return !!chrome && chrome.child.exitCode == null && !chrome.child.killed;
}

function disposeWarmChrome() {
  if (warmChromeTimer) { clearTimeout(warmChromeTimer); warmChromeTimer = null; }
  const current = warmChrome; warmChrome = null;
  if (!current) return;
  try { current.child.kill('SIGTERM'); } catch {}
  try { fs.rmSync(current.profile, { recursive: true, force: true }); } catch {}
}

export async function prewarmDgChromium(onLog: (message: string) => void = () => {}) {
  if (chromeAlive(warmChrome)) return true;
  if (warmChromePromise) { await warmChromePromise; return true; }
  const executable = findChromeExecutable();
  if (!executable) throw new Error('找不到 Chrome/Chromium；請確認 postinstall 已完成');
  warmChromePromise = launchChrome(executable, `warm-${Date.now()}`, message => onLog(`預熱｜${message}`))
    .then(chrome => {
      warmChrome = chrome;
      chrome.child.once('exit', () => { if (warmChrome === chrome) warmChrome = null; });
      if (warmChromeTimer) clearTimeout(warmChromeTimer);
      warmChromeTimer = setTimeout(() => { if (warmChrome === chrome) disposeWarmChrome(); }, 10 * 60 * 1000);
      warmChromeTimer.unref?.();
      return chrome;
    })
    .finally(() => { warmChromePromise = null; });
  await warmChromePromise;
  return true;
}

async function takeWarmOrLaunchChrome(executable: string, sessionId: string, onLog: (message: string) => void) {
  if (warmChromePromise) { try { await warmChromePromise; } catch {} }
  if (chromeAlive(warmChrome)) {
    const chrome = warmChrome!; warmChrome = null;
    if (warmChromeTimer) { clearTimeout(warmChromeTimer); warmChromeTimer = null; }
    onLog(`使用已預熱 Chromium｜pid=${chrome.child.pid}`);
    return chrome;
  }
  return launchChrome(executable, sessionId, onLog);
}

export async function startDgChromiumTransport(hooks: DgChromiumHooks): Promise<DgChromiumTransport> {
  const executable = findChromeExecutable();
  if (!executable) throw new Error('找不到 Chrome/Chromium；請確認 postinstall 已完成');

  hooks.onLog('正在以真正 Chromium 開啟 DG 頁面');
  const launched = await takeWarmOrLaunchChrome(executable, hooks.sessionId, hooks.onLog);
  const cdp = new CdpClient(launched.wsUrl);
  await cdp.ready();

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const pageSessionId = String(attached.sessionId || '');
  if (!pageSessionId) throw new Error('Chromium target attach failed');

  let stopped = false;
  let got101 = false;
  let finalUrl = hooks.gameUrl;
  let diagCount = 0;
  let wsCreatedCount = 0;
  let wsHandshakeCount = 0;
  let failedRequestCount = 0;
  const dgRequests = new Map<string, string>();
  const requests = new Map<string, RequestMeta>();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  const diag = (message: string) => {
    if (diagCount >= 180) return;
    diagCount++;
    hooks.onLog(`Chromium DIAG｜${message}`);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (watchdog) clearTimeout(watchdog);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    try { cdp.close(); } catch {}
    try { launched.child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (!launched.child.killed) launched.child.kill('SIGKILL'); } catch {} }, 1200).unref?.();
    try { fs.rmSync(launched.profile, { recursive: true, force: true }); } catch {}
  };

  const dumpPageState = async (reason: string) => {
    if (stopped) return;
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
          href: location.href,
          origin: location.origin,
          readyState: document.readyState,
          title: document.title,
          bodyLength: document.body ? document.body.innerText.length : -1,
          scriptCount: document.scripts ? document.scripts.length : -1,
          iframeCount: document.querySelectorAll ? document.querySelectorAll('iframe').length : -1,
          localStorageKeys: (() => { try { return Object.keys(localStorage); } catch { return ['<blocked>']; } })(),
          sessionStorageKeys: (() => { try { return Object.keys(sessionStorage); } catch { return ['<blocked>']; } })(),
          userAgent: navigator.userAgent,
          webdriver: navigator.webdriver,
          languages: navigator.languages,
          online: navigator.onLine
        }))()`,
        returnByValue: true,
        awaitPromise: true,
      }, pageSessionId, 8000);
      const value = result?.result?.value || {};
      diag(`頁面狀態(${reason})｜url=${redactUrl(String(value.href || finalUrl))}｜ready=${value.readyState}｜title=${safeText(value.title, 120)}｜body=${value.bodyLength}｜scripts=${value.scriptCount}｜iframes=${value.iframeCount}｜webdriver=${String(value.webdriver)}｜online=${String(value.online)}`);
      diag(`Storage(${reason})｜local=[${(Array.isArray(value.localStorageKeys) ? value.localStorageKeys : []).slice(0, 30).join(',')}]｜session=[${(Array.isArray(value.sessionStorageKeys) ? value.sessionStorageKeys : []).slice(0, 30).join(',')}]`);
    } catch (error) {
      diag(`頁面狀態讀取失敗(${reason})｜${safeText((error as Error)?.message || error)}`);
    }

    try {
      const cookies = await cdp.send('Network.getCookies', { urls: [finalUrl] }, pageSessionId, 8000);
      const names = Array.isArray(cookies?.cookies) ? cookies.cookies.map((x: any) => String(x?.name || '')).filter(Boolean).slice(0, 40) : [];
      diag(`Cookies(${reason})｜count=${Array.isArray(cookies?.cookies) ? cookies.cookies.length : 0}｜names=[${names.join(',')}]`);
    } catch (error) {
      diag(`Cookies 讀取失敗(${reason})｜${safeText((error as Error)?.message || error)}`);
    }
  };

  cdp.onEvent((message) => {
    if (stopped || message.sessionId !== pageSessionId) return;
    const p = message.params || {};

    if (message.method === 'Page.frameNavigated') {
      const frame = p.frame || {};
      if (!frame.parentId && /^https:\/\//i.test(String(frame.url || ''))) {
        finalUrl = String(frame.url);
        hooks.onMainUrl?.(finalUrl);
        hooks.onLog(`Chromium 頁面：${redactUrl(finalUrl)}`);
      }
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const level = String(p.type || 'log');
      if (!['error', 'warning', 'assert'].includes(level)) return;
      const text = (Array.isArray(p.args) ? p.args : []).map(cdpRemoteValue).join(' ');
      diag(`Console ${level}｜${safeText(text, 700)}`);
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const detail = p.exceptionDetails || {};
      const description = detail.exception?.description || detail.text || 'unknown exception';
      const where = detail.url ? `｜${redactUrl(String(detail.url))}:${detail.lineNumber ?? '?'}:${detail.columnNumber ?? '?'}` : '';
      diag(`JS Exception｜${safeText(description, 900)}${where}`);
      return;
    }

    if (message.method === 'Log.entryAdded') {
      const entry = p.entry || {};
      if (String(entry.level || '').toLowerCase() === 'error' || String(entry.source || '').toLowerCase() === 'javascript') {
        diag(`Browser Log｜${safeText(entry.text, 700)}${entry.url ? `｜${redactUrl(String(entry.url))}` : ''}`);
      }
      return;
    }

    if (message.method === 'Network.requestWillBeSent') {
      const requestId = String(p.requestId || '');
      const url = String(p.request?.url || '');
      const type = String(p.type || 'Other');
      const method = String(p.request?.method || 'GET');
      if (requestId) requests.set(requestId, { url, type, method });
      if (interestingRequest(url, type) && /game_settings\.json/i.test(url)) {
        diag(`REQ ${type} ${method}｜${redactUrl(url)}`);
      }
      return;
    }

    if (message.method === 'Network.responseReceived') {
      const requestId = String(p.requestId || '');
      const meta = requests.get(requestId);
      const url = String(p.response?.url || meta?.url || '');
      const status = Number(p.response?.status || 0);
      const type = String(p.type || meta?.type || 'Other');
      if (interestingRequest(url, type) && (status >= 400 || /game_settings\.json/i.test(url))) {
        diag(`RESP ${status || '?'} ${type}｜${redactUrl(url)}｜mime=${safeText(p.response?.mimeType, 80)}｜remote=${safeText(p.response?.remoteIPAddress, 80)}`);
      }
      return;
    }

    if (message.method === 'Network.loadingFailed') {
      const requestId = String(p.requestId || '');
      const meta = requests.get(requestId);
      failedRequestCount++;
      const url = meta?.url || '';
      diag(`LOAD FAIL ${meta?.type || p.type || 'Other'}｜${url ? redactUrl(url) : `requestId=${requestId}`}｜error=${safeText(p.errorText, 260)}｜blocked=${safeText(p.blockedReason, 120)}｜canceled=${String(!!p.canceled)}`);
      return;
    }

    if (message.method === 'Network.webSocketCreated') {
      const url = String(p.url || '');
      wsCreatedCount++;
      if (isDgWs(url)) {
        dgRequests.set(String(p.requestId), url);
        hooks.onLog(`Chromium WSS 建立：${new URL(url).hostname}`);
        diag(`WebSocketCreated｜host=${new URL(url).hostname}｜url=${redactUrl(url)}`);
      } else {
        diag(`WebSocketCreated(其他)｜${redactUrl(url)}`);
      }
      return;
    }

    if (message.method === 'Network.webSocketWillSendHandshakeRequest') {
      const requestId = String(p.requestId || '');
      const url = dgRequests.get(requestId);
      if (!url) return;
      const headers = p.request?.headers || {};
      const origin = headers.Origin || headers.origin || '';
      const ua = headers['User-Agent'] || headers['user-agent'] || '';
      diag(`WS HANDSHAKE REQ｜host=${new URL(url).hostname}｜Origin=${safeText(origin, 180)}｜UA=${safeText(ua, 180)}`);
      return;
    }

    if (message.method === 'Network.webSocketHandshakeResponseReceived') {
      const requestId = String(p.requestId || '');
      const url = dgRequests.get(requestId);
      if (!url) return;
      wsHandshakeCount++;
      const status = Number(p.response?.status || 0);
      const statusText = safeText(p.response?.statusText, 100);
      hooks.onLog(`Chromium WebSocket ${status || '?'}：${new URL(url).hostname}｜Origin=${(() => { try { return new URL(finalUrl).origin; } catch { return ''; } })()}`);
      diag(`WS HANDSHAKE RESP｜host=${new URL(url).hostname}｜status=${status || '?'} ${statusText}｜remote=${safeText(p.response?.remoteIPAddress, 100)}`);
      hooks.onHandshake?.(url, status);
      if (status === 101) {
        got101 = true;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        void dumpPageState('WS101');
      }
      return;
    }

    if (message.method === 'Network.webSocketFrameReceived') {
      const requestId = String(p.requestId || '');
      if (!dgRequests.has(requestId)) return;
      const response = p.response || {};
      if (Number(response.opcode) !== 2 || !response.payloadData) return;
      try { hooks.onBinary(Buffer.from(String(response.payloadData), 'base64')); } catch {}
      return;
    }

    if (message.method === 'Network.webSocketFrameError') {
      const requestId = String(p.requestId || '');
      const url = dgRequests.get(requestId);
      if (url) hooks.onLog(`Chromium WSS 錯誤：${new URL(url).hostname}｜${String(p.errorMessage || 'unknown')}`);
      diag(`WebSocketFrameError｜${safeText(p.errorMessage, 500)}`);
      return;
    }

    if (message.method === 'Network.webSocketClosed') {
      const requestId = String(p.requestId || '');
      const url = dgRequests.get(requestId);
      if (url) hooks.onLog(`Chromium WSS 已關閉：${new URL(url).hostname}`);
      diag(`WebSocketClosed｜host=${url ? new URL(url).hostname : 'unknown'}`);
      if (got101 && !stopped) hooks.onFailure?.('DG WebSocket 已中斷，等待自動恢復');
    }
  });

  await cdp.send('Network.enable', { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 2_000_000 }, pageSessionId);
  await cdp.send('Page.enable', {}, pageSessionId);
  await cdp.send('Runtime.enable', {}, pageSessionId);
  await cdp.send('Log.enable', {}, pageSessionId).catch(() => {});
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, pageSessionId).catch(() => {});
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, pageSessionId).catch(() => {});
  await cdp.send('Network.setUserAgentOverride', { userAgent: NORMAL_CHROME_UA, acceptLanguage: 'zh-TW,zh;q=0.9', platform: 'Windows' }, pageSessionId);

  // Track the real DG WebSocket created by the headless page. When the user opens
  // the foreground DG UI we keep this ONE upstream socket and forward the
  // foreground page's binary commands through it. This avoids opening a second
  // DG vendor session while still using Chromium's accepted TLS/Origin stack.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (window.__MT_DG_WS_TRACKER__) return;
    const NativeWS = window.WebSocket;
    window.__MT_DG_WS_TRACKER__ = { native: NativeWS, sockets: [], active: null };
    class TrackedWS extends NativeWS {
      constructor(url, protocols) {
        if (arguments.length > 1) super(url, protocols); else super(url);
        const box = window.__MT_DG_WS_TRACKER__;
        try { box.sockets.push(this); } catch {}
        this.addEventListener('open', () => { try { box.active = this; } catch {} });
        this.addEventListener('close', () => { try { if (box.active === this) box.active = box.sockets.find(x => x && x.readyState === 1) || null; } catch {} });
      }
    }
    try { Object.defineProperty(TrackedWS, 'CONNECTING', { value: NativeWS.CONNECTING }); } catch {}
    try { Object.defineProperty(TrackedWS, 'OPEN', { value: NativeWS.OPEN }); } catch {}
    try { Object.defineProperty(TrackedWS, 'CLOSING', { value: NativeWS.CLOSING }); } catch {}
    try { Object.defineProperty(TrackedWS, 'CLOSED', { value: NativeWS.CLOSED }); } catch {}
    window.WebSocket = TrackedWS;
  })();` }, pageSessionId).catch(() => {});

  // Diagnostic build intentionally DOES NOT block images/fonts/video.
  // We want the DG page to initialize exactly like a normal Chrome tab first.
  diag('資源阻擋已關閉：本版讓 DG 頁面完整載入，避免初始化流程因資源被擋而中斷');

  await cdp.send('Page.navigate', { url: hooks.gameUrl }, pageSessionId, 15000);
  hooks.onLog(`Chromium 已導航至 DG direct1｜host=${new URL(hooks.gameUrl).hostname}`);

  snapshotTimer = setTimeout(() => { void dumpPageState('5s'); }, 5000);

  watchdog = setTimeout(() => {
    if (stopped || got101) return;
    const message = `Chromium 20 秒內仍未取得 DG WebSocket 101｜wsCreated=${wsCreatedCount}｜handshake=${wsHandshakeCount}｜loadFailed=${failedRequestCount}`;
    // 20s is diagnostic only. Real captures can create the DG WSS just after
    // this point; treating it as a hard failure caused the frontend recovery
    // path to request a fresh token and stop the relay exactly as 101 arrived.
    hooks.onLog(`${message}｜繼續等待，不重啟`);
    void dumpPageState('20s');
    watchdog = setTimeout(() => {
      if (stopped || got101) return;
      const hard = `Chromium 45 秒內仍未取得 DG WebSocket 101｜wsCreated=${wsCreatedCount}｜handshake=${wsHandshakeCount}｜loadFailed=${failedRequestCount}`;
      hooks.onLog(hard);
      void dumpPageState('45s');
      hooks.onFailure?.(hard);
    }, 25000);
  }, 20000);

  launched.child.once('exit', (code, signal) => {
    if (stopped) return;
    hooks.onFailure?.(`Chromium 意外結束 (code=${code}, signal=${signal})`);
  });

  let sendChain = Promise.resolve<boolean>(true);
  const sendBinary = (data: Buffer) => {
    const b64 = Buffer.from(data).toString('base64');
    sendChain = sendChain.catch(() => false).then(async () => {
      if (stopped) return false;
      try {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            try {
              const box = window.__MT_DG_WS_TRACKER__;
              const ws = box && (box.active && box.active.readyState === 1 ? box.active : box.sockets.find(x => x && x.readyState === 1));
              if (!ws) return false;
              const raw = atob(${JSON.stringify(b64)});
              const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
              ws.send(bytes.buffer);
              box.active = ws;
              return true;
            } catch { return false; }
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }, pageSessionId, 8000);
        return !!result?.result?.value;
      } catch { return false; }
    });
    return sendChain;
  };

  return { stop, sendBinary };
}

// AB uses readable JSON frames, while DB decrypts its binary frames inside its
// own page.  Running the genuine launch page is therefore the only stable way
// to preserve rotating hosts, keys and tokens.  This bridge observes objects
// after the vendor page has decoded them; it never stores a HAR token/key.
export async function startVendorBrowserTransport(hooks: VendorBrowserHooks): Promise<VendorBrowserTransport> {
  const executable = findChromeExecutable();
  if (!executable) throw new Error('找不到 Chrome/Chromium；請確認 postinstall 已完成');
  const launched = await launchChrome(executable, `${hooks.label.toLowerCase()}-${hooks.sessionId}`, hooks.onLog);
  const cdp = new CdpClient(launched.wsUrl);
  await cdp.ready();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const pageSessionId = String(attached.sessionId || '');
  if (!pageSessionId) throw new Error(`${hooks.label} Chromium target attach failed`);
  let stopped = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (stopped) return; stopped = true;
    if (poll) clearInterval(poll);
    try { cdp.close(); } catch {}
    try { launched.child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (!launched.child.killed) launched.child.kill('SIGKILL'); } catch {} }, 1200).unref?.();
    try { fs.rmSync(launched.profile, { recursive: true, force: true }); } catch {}
  };
  launched.child.once('exit', (code, signal) => {
    if (!stopped) hooks.onFailure?.(`${hooks.label} Chromium 意外結束 (code=${code}, signal=${signal})`);
  });
  await cdp.send('Network.enable', {}, pageSessionId);
  await cdp.send('Page.enable', {}, pageSessionId);
  await cdp.send('Runtime.enable', {}, pageSessionId);
  await cdp.send('Network.setUserAgentOverride', { userAgent: NORMAL_CHROME_UA, acceptLanguage: 'zh-TW,zh;q=0.9', platform: 'Windows' }, pageSessionId);
  // AB frames are plain JSON. Observe them at the DevTools network layer as
  // well as inside the page, because a vendor may create its WebSocket in a
  // worker where a window-level WebSocket wrapper cannot see it.
  cdp.onEvent((message) => {
    if (stopped || message.sessionId !== pageSessionId) return;
    if (message.method !== 'Network.webSocketFrameReceived') return;
    const response = message.params?.response || {};
    if (Number(response.opcode) !== 1 || typeof response.payloadData !== 'string') return;
    try { hooks.onObject(JSON.parse(response.payloadData)); } catch {}
  });
  const source = `(() => {
    if (window.__MT_VENDOR_TAP__) return;
    const q=[]; const seen=new WeakSet();
    const keep=(v,depth=0)=>{
      if(!v||typeof v!=='object'||depth>5)return;
      if(seen.has(v))return; seen.add(v);
      try{
        const c=v.c, p=v.p;
        if(typeof c==='string' || v.tableId!=null || v.gameId!=null || v.roads || v.roadmaps || v.gameCode || v.tableCode){
          q.push(JSON.parse(JSON.stringify(v))); if(q.length>2000)q.splice(0,q.length-1500);
        }
        if(Array.isArray(v)){ for(let i=0;i<Math.min(v.length,250);i++)keep(v[i],depth+1); }
        else for(const k of Object.keys(v).slice(0,120))keep(v[k],depth+1);
      }catch{}
    };
    const parse=JSON.parse;
    JSON.parse=function(){ const v=parse.apply(this,arguments); try{keep(v)}catch{} return v };
    const NativeWS=window.WebSocket;
    class TapWS extends NativeWS {
      constructor(url,protocols){ if(arguments.length>1)super(url,protocols);else super(url);
        this.addEventListener('message',e=>{try{if(typeof e.data==='string')keep(parse(e.data))}catch{}});
      }
    }
    for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])try{Object.defineProperty(TapWS,k,{value:NativeWS[k]})}catch{}
    window.WebSocket=TapWS;
    window.__MT_VENDOR_TAP__={drain:()=>q.splice(0,250),keep};
  })();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, pageSessionId);
  await cdp.send('Page.navigate', { url: hooks.gameUrl }, pageSessionId, 15000);
  hooks.onLog(`${hooks.label} 真實頁面已啟動`);
  let busy=false;
  poll=setInterval(async()=>{
    if(stopped||busy)return; busy=true;
    try{
      const out=await cdp.send('Runtime.evaluate',{expression:`window.__MT_VENDOR_TAP__?window.__MT_VENDOR_TAP__.drain():[]`,returnByValue:true},pageSessionId,8000);
      const values=out?.result?.value;
      if(Array.isArray(values))for(const value of values)hooks.onObject(value);
    }catch(e:any){ if(!stopped)hooks.onLog(`${hooks.label} 解碼資料讀取重試：${safeText(e?.message||e,160)}`); }
    finally{busy=false}
  },120);
  poll.unref?.();
  return { stop };
}
