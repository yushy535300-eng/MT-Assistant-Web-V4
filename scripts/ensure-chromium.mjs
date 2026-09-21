import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const installRoot = path.join(root, '.chrome');
const bundledChrome = path.join(installRoot, 'opt', 'google', 'chrome', 'google-chrome');
const systemCandidates = [
  process.env.DG_CHROME_PATH,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const existsExecutable = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
};

const smokeTest = (executable) => {
  const result = spawnSync(
    executable,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--dump-dom', 'about:blank'],
    { encoding: 'utf8', timeout: 20000 },
  );
  if (result.status === 0) return { ok: true, detail: 'ok' };
  const err = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error?.message || ''}`.trim();
  return { ok: false, detail: err.slice(-800) };
};

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.log(`[DG Chromium] skip install on ${process.platform}/${process.arch}`);
  process.exit(0);
}

const prefer = systemCandidates.find(existsExecutable);
if (prefer) {
  const smoke = smokeTest(prefer);
  if (smoke.ok) {
    console.log(`[DG Chromium] system Chrome/Chromium already available: ${prefer}`);
    process.exit(0);
  }
  console.warn(`[DG Chromium] system Chrome unusable (${prefer}): ${smoke.detail}`);
}

if (existsExecutable(bundledChrome)) {
  const smoke = smokeTest(bundledChrome);
  if (smoke.ok) {
    console.log('[DG Chromium] cached Chrome already available');
    process.exit(0);
  }
  console.warn(`[DG Chromium] cached Chrome failed smoke test, reinstalling: ${smoke.detail}`);
  fs.rmSync(installRoot, { recursive: true, force: true });
}

fs.mkdirSync(installRoot, { recursive: true });
const debPath = path.join(installRoot, 'google-chrome-stable_current_amd64.deb');
const url = process.env.DG_CHROME_DOWNLOAD_URL || 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';

console.log(`[DG Chromium] downloading Chrome: ${url}`);
const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
if (!response.ok || !response.body) throw new Error(`Chrome download failed: HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(debPath));

let extracted = false;
const dpkg = spawnSync('dpkg-deb', ['-x', debPath, installRoot], { stdio: 'inherit' });
if (dpkg.status === 0) extracted = true;

if (!extracted) {
  const temp = path.join(installRoot, '.deb-unpack');
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const ar = spawnSync('ar', ['x', debPath], { cwd: temp, stdio: 'inherit' });
  if (ar.status !== 0) throw new Error('Chrome package extraction failed: dpkg-deb/ar unavailable');
  const dataArchive = fs.readdirSync(temp).find((name) => /^data\.tar\./.test(name));
  if (!dataArchive) throw new Error('Chrome package extraction failed: data archive missing');
  const tar = spawnSync('tar', ['-xf', path.join(temp, dataArchive), '-C', installRoot], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Chrome package extraction failed: tar failed');
  extracted = true;
  fs.rmSync(temp, { recursive: true, force: true });
}

try { fs.chmodSync(bundledChrome, 0o755); } catch {}
fs.rmSync(debPath, { force: true });

if (!existsExecutable(bundledChrome)) throw new Error(`Chrome executable not found after extraction: ${bundledChrome}`);

const smoke = smokeTest(bundledChrome);
if (!smoke.ok) {
  const missing = smoke.detail.match(/error while loading shared libraries:\s*([^\s:]+)/i)?.[1];
  console.error(`[DG Chromium] installed but cannot launch: ${smoke.detail}`);
  if (missing) {
    console.error(`[DG Chromium] missing library: ${missing}`);
    console.error('[DG Chromium] Render Native Node 無法 apt-get 安裝系統套件。請改用 Docker 部署（見 RENDER_DEPLOY.md）。');
  }
  // Do not fail the whole install on platforms without libs — runtime will surface a clear error.
  // Docker builds should install deps so smoke passes.
  if (process.env.DG_CHROME_REQUIRE_SMOKE === '1') {
    throw new Error(`Chrome smoke test failed${missing ? ` (missing ${missing})` : ''}`);
  }
  process.exit(0);
}

console.log(`[DG Chromium] installed and verified: ${bundledChrome}`);
