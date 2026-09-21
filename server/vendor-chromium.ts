import fs from 'node:fs';
import { rememberDbChromeResponse } from './vendor-db-cache';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

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
  shouldAbort?: () => boolean;
};

export type VendorBrowserTransport = {
  stop: () => Promise<void> | void;
  park?: () => Promise<void> | void;
  fetchUrl?: (url: string) => Promise<{ status: number; contentType: string; body: Buffer } | null>;
};

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
type RequestMeta = { url: string; type: string; method: string };

export function findChromeExecutable() {
  const root = process.cwd();
  const localApp = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.DG_CHROME_PATH,
    process.env.CHROME_PATH,
    path.join(root, '.chrome', 'opt', 'google', 'chrome', 'google-chrome'),
    path.join(root, '.chrome', 'chrome-linux64', 'chrome'),
    path.join(root, '.chrome', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localApp ? path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter((x): x is string => !!x);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  try {
    const out = execFileSync("where", ["chrome"], { encoding: "utf8", timeout: 4000, windowsHide: true });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find((s) => /\.exe$/i.test(s));
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return "";
}

export function getChromeStatus() {
  const executable = findChromeExecutable();
  return {
    available: !!executable,
    executable: executable || null,
    hint: executable
      ? null
      : "找不到 Chrome/Chromium；請 Clear build cache 後重新部署，或改用 Docker（見 RENDER_DEPLOY.md）",
  };
}

/** Serialize Chrome launches so AB+DB don't OOM the Render free tier at the same instant. */
let chromeLaunchTail: Promise<unknown> = Promise.resolve();
function withChromeLaunchLock<T>(job: () => Promise<T>): Promise<T> {
  const run = chromeLaunchTail.then(job, job);
  chromeLaunchTail = run.then(() => undefined, () => undefined);
  return run;
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
    for (const key of ['token', 'sign', 'auth', 'authorization', 'session', 'sessionId', 'params', 'jwtToken', 'signature']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return String(value || '')
      .replace(/([?&](?:token|sign|auth|authorization|session|sessionId|jwtToken|signature)=)[^&#\s]+/gi, '$1***')
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

async function launchChrome(executable: string, sessionId: string, onLog: (message: string) => void, extraArgs: string[] = []) {
  return withChromeLaunchLock(async () => {
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
      ...extraArgs,
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
        const missingLib = stderr.match(/error while loading shared libraries:\s*([^\s:]+)/i)?.[1];
        const hint = missingLib
          ? `缺少系統函式庫 ${missingLib}（請改用 Docker 部署，見 RENDER_DEPLOY.md）`
          : stderr.slice(-500);
        reject(new Error(`Chromium exited before DevTools was ready (code=${code}, signal=${signal})${hint ? `: ${hint}` : ''}`));
      });
      child.once('error', err => {
        if (resolved) return;
        resolved = true; clearTimeout(timer); reject(err);
      });
    });
    onLog(`Chromium 已啟動｜pid=${child.pid}｜exe=${executable}`);
    return { child, profile, wsUrl };
  });
}

type LaunchedChrome = Awaited<ReturnType<typeof launchChrome>>;
let warmChrome: LaunchedChrome | null = null;
let warmChromePromise: Promise<LaunchedChrome> | null = null;
let warmChromeTimer: ReturnType<typeof setTimeout> | null = null;

function killChromeTree(child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 8000 }); } catch {}
    return;
  }
  try { child.kill("SIGKILL"); } catch {}
}

function waitUntilChromeDead(child: ChildProcessWithoutNullStreams, timeoutMs = 8000) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(tick);
      resolve();
    };
    const tick = setInterval(() => {
      if (child.exitCode != null) return finish();
      killChromeTree(child);
    }, 400);
    child.once("exit", finish);
    killChromeTree(child);
    setTimeout(finish, timeoutMs).unref?.();
    tick.unref?.();
  });
}

export function killLeftoverVendorChrome() {
  if (process.platform === "win32") {
    try {
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*dg-chrome-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ], { stdio: "ignore", windowsHide: true, timeout: 12000 });
    } catch {}
    return;
  }
  try { execFileSync("pkill", ["-f", "dg-chrome-"], { stdio: "ignore", timeout: 8000 }); } catch {}
}

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
  const ua = NORMAL_CHROME_UA;
  const launched = await launchChrome(
    executable,
    `${hooks.label.toLowerCase()}-${hooks.sessionId}`,
    hooks.onLog,
    ['--timezone=Asia/Taipei', '--lang=zh-TW'],
  );
  if (hooks.shouldAbort?.()) {
    hooks.onLog(`${hooks.label} 進桌已暫停，背景瀏覽器未導向登入頁`);
    killChromeTree(launched.child);
    try { fs.rmSync(launched.profile, { recursive: true, force: true }); } catch {}
    return { stop: async () => {} };
  }
  const cdp = new CdpClient(launched.wsUrl);
  await cdp.ready();
  const vendorSessions = new Set<string>();
  const instrumentedSessions = new Set<string>();
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const pageSessionId = String(attached.sessionId || '');
  if (!pageSessionId) throw new Error(`${hooks.label} Chromium target attach failed`);
  vendorSessions.add(pageSessionId);
  let stopped = false;
  let parked = false;
  let mainFrameId = "";
  let poll: ReturnType<typeof setInterval> | null = null;
  let diagnostics: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    stopped = true;
    if (poll) { clearInterval(poll); poll = null; }
    if (diagnostics) { clearInterval(diagnostics); diagnostics = null; }
    try { cdp.close(); } catch {}
    return waitUntilChromeDead(launched.child).then(() => {
      try { fs.rmSync(launched.profile, { recursive: true, force: true }); } catch {}
    });
  };
  launched.child.once('exit', (code, signal) => {
    if (!stopped) hooks.onFailure?.(`${hooks.label} Chromium 意外結束 (code=${code}, signal=${signal})`);
  });
  const counters={targets:1,contexts:0,ws:0,frames:0,binary:0,json:0,objects:0,responses:0};
  const responseRequests=new Map<string,{requestId:string,mime:string,kind:"json"|"asset",url?:string}>();
  const source = `(() => {
    const root=globalThis;
    const q=root.__MT_VENDOR_TAP__&&root.__MT_VENDOR_TAP__.q||[];
    const nativeParse=root.JSON&&root.JSON.parse&&!root.JSON.parse.__mtVendor?root.JSON.parse.bind(root.JSON):root.__MT_VENDOR_NATIVE_PARSE__||(root.JSON?root.JSON.parse.bind(root.JSON):null);
    if(nativeParse) root.__MT_VENDOR_NATIVE_PARSE__=nativeParse;
    const toObj=(v)=>{
      if(!v||typeof v!=='object')return v;
      if(v instanceof Map) return Object.fromEntries([...v.entries()].slice(0,800));
      if(typeof v.keys==='function'&&typeof v.get==='function'&&typeof v.forEach==='function'&&!(v instanceof Map)){
        try{const o={};v.forEach((val,key)=>{if(o&&Object.keys(o).length<800)o[String(key)]=val});if(Object.keys(o).length)return o;}catch{}
      }
      return v;
    };
    const emit=(v)=>{
      try{
        const json=JSON.stringify(v,(k,val)=>{
          if(val instanceof Map) return Object.fromEntries([...val.entries()].slice(0,800));
          if(val && typeof val==='object' && val.__v_isRef) return val.value;
          if(typeof val==='bigint') return Number(val);
          return val;
        });
        if(!json||json.length>1200000)return;
        if(typeof root.__mtVendorPush==='function')root.__mtVendorPush(json);
        else {q.push((nativeParse||JSON.parse)(json));if(q.length>2000)q.splice(0,q.length-1500)}
      }catch{}
    };
    const emitChunks=(key,raw)=>{
      const obj=toObj(raw);
      if(!obj||typeof obj!=='object')return;
      const entries=Array.isArray(obj)?obj.map((t,i)=>[String(i),t]):Object.entries(obj);
      for(let i=0;i<entries.length;i+=40){
        const chunk={}; for(const [k,val] of entries.slice(i,i+40)) chunk[k]=val;
        emit({[key]:chunk});
      }
    };
    const keep=(v,depth=0,seen=new WeakSet())=>{
      if(depth>8||v==null)return;
      if(typeof v==='string' && (v.trim().startsWith('{')||v.trim().startsWith('['))){try{keep((nativeParse||JSON.parse)(v),depth+1,seen)}catch{}return}
      if(typeof v!=='object')return;
      if(seen.has(v))return; seen.add(v);
      try{
        if(v.__v_isRef){keep(v.value,depth+1,seen);return}
        if(v.gameTableMap) emitChunks('gameTableMap', v.gameTableMap);
        if(v.tableMap) emitChunks('gameTableMap', v.tableMap);
        if(v.tablesMap) emitChunks('gameTableMap', v.tablesMap);
        if(v.roadPaperCacheMap) emitChunks('roadPaperCacheMap', v.roadPaperCacheMap);
        if(v.protocolId!=null || v.jsonData!=null){
          try{
            let json=v.jsonData; if(typeof json==='string') json=(nativeParse||JSON.parse)(json);
            let data=json&&json.data!=null?json.data:v.data;
            if(typeof data==='string') data=(nativeParse||JSON.parse)(data);
            const flat=Object.assign({}, v, json&&typeof json==='object'?json:{}, data&&typeof data==='object'?data:{});
            if(data&&data.gameTypeId!=null&&Number(data.gameTypeId)!==2013) flat.gameTypeId=data.gameTypeId;
            else if(Number(flat.gameTypeId)===2013) delete flat.gameTypeId;
            if(flat.gameTableMap) emitChunks('gameTableMap', flat.gameTableMap);
            else if(flat.roadPaperCacheMap) emitChunks('roadPaperCacheMap', flat.roadPaperCacheMap);
            else emit(flat);
          }catch{ emit(v); }
        }
        if(typeof v.c==='string' || v.protocolId!=null || v.jsonData!=null || v.gameTableMap || v.tableMap || v.roadPaperCacheMap || v.roadPaper || v.tableId!=null || v._tableId!=null || v.gameId!=null || v.roads || v.roadmaps || v.gameCode || v.cmd || v.WW3 || v.beatPlateRoad || v.tableList || v.gameTableList || v.currentRoundExtInfos || v.currentRoundExtInfo || (v.cardNumber!=null && v.cardOwner!=null) || v.bootIndex!=null){
          emit(v);
        }
        if(v instanceof Map){for(const x of v.values())keep(x,depth+1,seen)}
        else if(Array.isArray(v)){ for(let i=0;i<Math.min(v.length,600);i++)keep(v[i],depth+1,seen); }
        else for(const k of Object.keys(v).slice(0,400))keep(v[k],depth+1,seen);
      }catch{}
    };
    const hunt=()=>{
      try{
        const seen=new WeakSet();
        const walk=(v,depth)=>{
          if(!v||depth>6||typeof v!=='object'||seen.has(v))return;
          seen.add(v);
          try{
            if(v.gameTableMap||v.tableMap||v.tablesMap||v.roadPaperCacheMap||v.protocolId!=null||v.jsonData!=null||v.beatPlateRoad||v.roadPaper||v._tableId!=null||v._roadPaperDataMap||v.currentRoundExtInfos||v.currentRoundExtInfo||v.bootIndex!=null||(v.tableId!=null&&v.cardNumber!=null)) keep(v);
            if(depth>=5)return;
            const keys=Object.keys(v).slice(0,120);
            for(const k of keys){
              if(/table|hall|room|proto|socket|cache|road|gameType|jsonData|map|card|round|boot/i.test(k)) walk(v[k],depth+1);
            }
          }catch{}
        };
        for(const k of Object.getOwnPropertyNames(root).slice(0,400)){
          if(/egret|game|hall|table|socket|net|app|main|db|live|room/i.test(k)) walk(root[k],0);
        }
      }catch{}
    };
    if(root.JSON&&typeof nativeParse==='function'&&!root.JSON.parse.__mtVendor){
      const hooked=function(){ const v=nativeParse.apply(root.JSON,arguments); try{keep(v)}catch{} return v };
      hooked.__mtVendor=true;
      try{root.JSON.parse=hooked;}catch{}
    }
    try{
      const NativeWS=root.WebSocket;
      if(NativeWS&&!NativeWS.__mtVendor){
        class TapWS extends NativeWS {
          constructor(url,protocols){ if(arguments.length>1)super(url,protocols);else super(url);
            this.addEventListener('message',e=>{try{
              if(typeof e.data==='string')keep((nativeParse||JSON.parse)(e.data));
              else if(e.data&&typeof e.data.arrayBuffer==='function')e.data.arrayBuffer().then(b=>{
                try{
                  const bytes=new Uint8Array(b);
                  const text=(typeof TextDecoder==='function'?new TextDecoder('utf-8',{fatal:false}):null)?.decode(bytes.subarray(0,Math.min(bytes.length,400000)))||'';
                  const start=text.indexOf('{');
                  if(start>=0){const slice=text.slice(start).trim(); if(slice.includes('gameTableMap')||slice.includes('protocolId')||slice.includes('jsonData')||slice.includes('roadPaper')||slice.includes('beatPlateRoad')||slice.includes('currentRoundExtInfos')||slice.includes('cardNumber')||slice.includes('bootIndex')||slice.includes('"tableId"')) keep(slice);}
                }catch{}
                const n=Date.now(); if(!root.__MT_VENDOR_HUNT_AT__||n-root.__MT_VENDOR_HUNT_AT__>800){root.__MT_VENDOR_HUNT_AT__=n;hunt();}
              }).catch(()=>{});
            }catch{}});
          }
        }
        TapWS.__mtVendor=true;
        for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])try{Object.defineProperty(TapWS,k,{value:NativeWS[k]})}catch{}
        root.WebSocket=TapWS;
      }
    }catch{}
    const scan=()=>{
      try{hunt()}catch{}
    };
    const snapshot=()=>{try{scan();}catch{}};
    if(typeof document!=='undefined'&&!root.__MT_VENDOR_SCAN__){root.__MT_VENDOR_SCAN__=1;setInterval(scan,1000)}
    root.__MT_VENDOR_TAP__={q,drain:()=>q.splice(0,120),keep,scan,snapshot,hunt};
  })();`;
  const probeSource = `(() => {
    try {
      const text=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,180);
      const iframes=[...document.querySelectorAll('iframe')].map(f=>String(f.src||'')).filter(Boolean).slice(0,6);
      return {href:String(location.href||''),title:String(document.title||''),ready:String(document.readyState||''),iframes,text,clicked:false,tap:!!window.__MT_VENDOR_TAP__};
    } catch (e) { return {error:String(e&&e.message||e)}; }
  })()`;
  const instrumentSession=async(sessionId:string)=>{
    if(!sessionId||instrumentedSessions.has(sessionId))return;
    instrumentedSessions.add(sessionId); vendorSessions.add(sessionId);
    await cdp.send('Network.enable',{},sessionId).catch(()=>{});
    await cdp.send('Runtime.enable',{},sessionId).catch(()=>{});
    await cdp.send('Runtime.addBinding',{name:'__mtVendorPush'},sessionId).catch(()=>{});
    await cdp.send('Page.enable',{},sessionId).catch(()=>{});
    await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId).catch(()=>{});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source},sessionId).catch(()=>{});
    const injected=await cdp.send('Runtime.evaluate',{expression:source,returnByValue:true},sessionId,8000).catch((e)=>({error:e}));
    const injectErr=injected?.exceptionDetails?.text||injected?.exceptionDetails?.exception?.description||injected?.error?.message;
    if(injectErr)hooks.onLog(`頁面注入失敗｜${safeText(injectErr,180)}`);
    await cdp.send('Network.setUserAgentOverride',{userAgent:ua,acceptLanguage:'zh-TW,zh;q=0.9,en;q=0.8',platform:'Windows'},sessionId).catch(()=>{});
    await cdp.send('Network.setExtraHTTPHeaders',{headers:{'Accept-Language':'zh-TW,zh;q=0.9,en;q=0.8'}},sessionId).catch(()=>{});
    await cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId).catch(()=>{});
    hooks.onLog(`監聽目標已安裝｜session=${sessionId.slice(0,8)}`);
  };
  cdp.onEvent((message) => {
    if (stopped) return;
    if(message.method==='Target.attachedToTarget'){
      counters.targets++;
      const info=message.params?.targetInfo||{};
      const kind=String(info.type||'');
      hooks.onLog(`發現目標｜type=${safeText(kind,30)}｜url=${redactUrl(String(info.url||'')).slice(0,220)}`);
      if(kind==='service_worker'||kind==='worker'||kind==='shared_worker')return;
      void instrumentSession(String(message.params?.sessionId||''));
      return;
    }
    if(message.method==='Page.frameNavigated'){
      const url=String(message.params?.frame?.url||'');
      const sid=String(message.sessionId||pageSessionId);
      if(url&&message.params?.frame?.parentId==null){
        mainFrameId=String(message.params?.frame?.id||mainFrameId);
        hooks.onLog(`主頁導向｜${redactUrl(url).slice(0,260)}`);
        void cdp.send('Runtime.evaluate',{expression:source},sid,8000).catch(()=>{});
      }
      return;
    }
    if(message.method==='Network.loadingFailed'){
      const p=message.params||{};
      if(p.type==='Document'||p.type==='WebSocket')hooks.onLog(`載入失敗｜type=${p.type}｜${safeText(p.errorText,120)}`);
      return;
    }
    const sessionId=String(message.sessionId||'');
    if (!vendorSessions.has(sessionId)) return;
    if(message.method==='Runtime.executionContextCreated'){
      counters.contexts++;
      const contextId=message.params?.context?.id;
      if(contextId!=null)void cdp.send('Runtime.evaluate',{expression:source,contextId},sessionId,8000).catch(()=>{});
      return;
    }
    if(message.method==='Runtime.bindingCalled'&&message.params?.name==='__mtVendorPush'){
      counters.objects++;
      try{hooks.onObject(JSON.parse(String(message.params?.payload||'')))}catch{}
      return;
    }
    if(message.method==='Network.webSocketCreated'){
      counters.ws++;
      hooks.onLog(`偵測即時 WebSocket｜${redactUrl(String(message.params?.url||'')).slice(0,260)}`);
      return;
    }
    if(message.method==='Network.webSocketClosed'){
      hooks.onLog(`WebSocket 已關閉｜code=${safeText(message.params?.code,12)}`);
      return;
    }
    if(message.method==='Network.webSocketFrameReceived'){
      counters.frames++;
      const response=message.params?.response||{};
      const opcode=Number(response.opcode);
      if(opcode!==1){
        counters.binary++;
        if(opcode===2&&typeof response.payloadData==='string'&&hooks.label==='DB'){
          try{
            const buf=Buffer.from(response.payloadData,'base64');
            const text=buf.toString('utf8');
            const start=text.indexOf('{');
            if(start>=0){
              const slice=text.slice(start).trim();
              if(/(gameTableMap|protocolId|jsonData|roadPaper|beatPlateRoad|currentRoundExtInfos|currentRoundExtInfo|bootIndex|"tableId"|cardNumber)/.test(slice)){
                counters.json++;
                hooks.onObject(JSON.parse(slice));
              }
            }
          }catch{}
        }
        return;
      }
      if(typeof response.payloadData!=='string')return;
      try{counters.json++;hooks.onObject(JSON.parse(response.payloadData))}catch{}
      return;
    }
    if(message.method==='Network.responseReceived'){
      const p=message.params||{},type=String(p.type||''),mime=String(p.response?.mimeType||'');
      const status=Number(p.response?.status);
      const url=String(p.response?.url||'');
      const reqKey=`${sessionId}:${p.requestId}`;
      if(hooks.label==='DB'&&type==='Document'&&status===403){
        hooks.onLog(`擷取狀態｜title=403 Forbidden｜text=Denied by http_ratelimit`);
      }
      if(hooks.label==='DB'&&status===200&&(
        type==='Document'||type==='Script'||type==='Stylesheet'||type==='Font'||type==='Wasm'||
        /\.(?:js|mjs|css|woff2?|ttf|otf|wasm)(?:\?|$)/i.test(url)||
        (type==='XHR'||type==='Fetch')&&/\/egret\//i.test(url)&&!/\/api\/live/i.test(url)
      )){
        responseRequests.set(reqKey,{requestId:String(p.requestId),mime,kind:"asset",url});
      }
      if((type==='XHR'||type==='Fetch')&&/json|text/i.test(mime))responseRequests.set(reqKey,{requestId:String(p.requestId),mime,kind:"json"});
      return;
    }
    if(message.method==='Network.loadingFinished'){
      const key=`${sessionId}:${message.params?.requestId}`,meta=responseRequests.get(key);
      if(!meta)return;responseRequests.delete(key);
      void cdp.send('Network.getResponseBody',{requestId:meta.requestId},sessionId,5000).then(body=>{
        if(meta.kind==="asset"&&meta.url){
          const buf=body?.base64Encoded?Buffer.from(String(body?.body||''),'base64'):Buffer.from(String(body?.body||''),'utf8');
          rememberDbChromeResponse(meta.url,200,meta.mime,buf);
          return;
        }
        let value:any=String(body?.body||'');
        if(body?.base64Encoded)value=Buffer.from(value,'base64').toString('utf8');
        try{value=JSON.parse(value)}catch{return}
        counters.responses++;hooks.onObject(value);
      }).catch(()=>{});
      return;
    }
  });
  await instrumentSession(pageSessionId);
  if (hooks.shouldAbort?.()) {
    hooks.onLog(`${hooks.label} 進桌已暫停，背景瀏覽器未導向登入頁`);
    await stop();
    return { stop };
  }
  await cdp.send('Page.navigate', { url: hooks.gameUrl }, pageSessionId, 15000).catch((error:any)=>{
    hooks.onLog(`頁面導向逾時，改為背景等待載入｜${safeText(error?.message||error,160)}`);
  });
  hooks.onLog(`${hooks.label} 真實頁面已啟動`);
  const drainSource=`(()=>{try{if(!window.__MT_VENDOR_TAP__)return{needInject:true,items:[]};return{needInject:false,items:window.__MT_VENDOR_TAP__.drain()}}catch(e){return{needInject:true,items:[]}}})()`;
  let busy=false;
  poll=setInterval(async()=>{
    if(stopped||busy)return; busy=true;
    try{
      const out=await cdp.send('Runtime.evaluate',{expression:drainSource,returnByValue:true},pageSessionId,8000).catch(()=>null);
      const value=out?.result?.value;
      if(value?.needInject)await cdp.send('Runtime.evaluate',{expression:source,returnByValue:true},pageSessionId,8000).catch(()=>{});
      const values=value?.items;
      if(Array.isArray(values))for(const item of values)hooks.onObject(item);
    }catch(e:any){ if(!stopped)hooks.onLog(`${hooks.label} 解碼資料讀取重試：${safeText(e?.message||e,160)}`); }
    finally{busy=false}
  },200);
  poll.unref?.();
  diagnostics=setInterval(async()=>{
    if(stopped)return;
    let page='';
    try{
      const probe=await cdp.send('Runtime.evaluate',{expression:probeSource,returnByValue:true},pageSessionId,4000);
      const v=probe?.result?.value||{};
      page=`｜url=${redactUrl(String(v.href||'')).slice(0,180)}｜title=${safeText(v.title,40)}｜iframes=${Array.isArray(v.iframes)?v.iframes.length:0}｜tap=${v.tap?'1':'0'}｜text=${safeText(v.text,80)}`;
    }catch{}
    hooks.onLog(`擷取狀態｜targets=${counters.targets}｜contexts=${counters.contexts}｜ws=${counters.ws}｜frames=${counters.frames}｜binary=${counters.binary}｜json=${counters.json}｜xhr=${counters.responses}｜objects=${counters.objects}${page}`);
  },15000);
  diagnostics.unref?.();
  const park = async () => {
    if (stopped || parked) return;
    parked = true;
    await cdp.send("Page.stopLoading", {}, pageSessionId, 4000).catch(() => {});
  };
  const fetchUrl = async (url: string) => {
    if (stopped) return null;
    try {
      const out = await cdp.send("Runtime.evaluate", {
        expression: `(async()=>{try{const r=await fetch(${JSON.stringify(url)},{credentials:"include",cache:"force-cache"});const buf=await r.arrayBuffer();if(buf.byteLength>12000000)return{status:r.status,type:r.headers.get("content-type")||"",b64:""};const bytes=new Uint8Array(buf);let bin="";for(let i=0;i<bytes.length;i+=32768)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return{status:r.status,type:r.headers.get("content-type")||"",b64:btoa(bin)};}catch(e){return{status:0,type:"",b64:"",err:String(e&&e.message||e)}}} )()`,
        awaitPromise: true,
        returnByValue: true,
      }, pageSessionId, 25000);
      const v = out?.result?.value;
      if (!v || Number(v.status) !== 200 || !v.b64) return null;
      return {
        status: 200,
        contentType: String(v.type || "application/octet-stream"),
        body: Buffer.from(String(v.b64), "base64"),
      };
    } catch {
      return null;
    }
  };
  return { stop, park, fetchUrl };
}
