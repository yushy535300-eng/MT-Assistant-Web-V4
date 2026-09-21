const LIMIT = 256;
const TTL_MS = 12 * 60 * 1000;
const MAX_BODY = 12 * 1024 * 1024;

type Hit = { status: number; contentType: string; body: Buffer; expires: number; html: boolean };

const cache = new Map<string, Hit>();

function isHtmlType(contentType: string) {
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

export function dbChromeCacheKey(url: string, contentType = "") {
  try {
    const u = new URL(url);
    if (isHtmlType(contentType) || /\/egret\/hall\/?$/i.test(u.pathname) || /\/h5\/?$/i.test(u.pathname)) {
      return u.origin + u.pathname.replace(/\/+$/, "") || u.origin + "/";
    }
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

export function rememberDbChromeResponse(url: string, status: number, contentType: string, body: Buffer) {
  if (status !== 200 || !body?.length || body.length > MAX_BODY) return;
  const html = isHtmlType(contentType) || /\/egret\/hall\/?$/i.test(url);
  const key = dbChromeCacheKey(url, contentType);
  const hit = { status, contentType: contentType || (html ? "text/html" : "application/octet-stream"), body, expires: Date.now() + TTL_MS, html };
  cache.set(key, hit);
  try {
    const u = new URL(url);
    const pathKey = u.origin + u.pathname;
    if (pathKey !== key) cache.set(pathKey, hit);
  } catch {}
  while (cache.size > LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function readDbChromeResponse(url: string | URL) {
  const raw = typeof url === "string" ? url : url.toString();
  const htmlKey = dbChromeCacheKey(raw, "text/html");
  const fullKey = dbChromeCacheKey(raw, "");
  let pathKey = "";
  try {
    const u = new URL(raw);
    pathKey = u.origin + u.pathname;
  } catch {}
  const hit = cache.get(htmlKey) || cache.get(fullKey) || (pathKey ? cache.get(pathKey) : null);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(htmlKey);
    cache.delete(fullKey);
    if (pathKey) cache.delete(pathKey);
    return null;
  }
  return hit;
}

export function hasDbChromeHallHtml(origin: string) {
  try {
    const hall = readDbChromeResponse(new URL("/egret/hall", origin));
    const h5 = readDbChromeResponse(new URL("/h5/", origin));
    return !!(hall?.html || h5?.html);
  } catch {
    return false;
  }
}
