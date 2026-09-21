# Render 部署

歐博／DB 背景牌路需要 **可啟動的 Chromium**。Render 的 Native Node 常缺系統函式庫，只解 `.deb` 不夠；**建議用 Docker**。

## 建議：Docker Web Service

1. Render → **New Web Service** → 連 GitHub repo  
2. **Language / Runtime:** Docker  
3. 使用本 repo 的 `Dockerfile`（已含 Chrome 相依套件）  
4. 第一次勾 **Clear build cache & deploy**

## 備案：Native Node（較容易缺 Chrome 函式庫）

- **Build Command:**

```bash
pnpm install --frozen-lockfile && pnpm build
```

- **Start Command:**

```bash
pnpm start
```

第一次或新增 `postinstall` 後，請勾 **Clear build cache & deploy**。只重啟舊服務不會裝 Chrome。

部署後打開：

```text
https://你的網域/api/health
```

確認回傳裡 `chrome.available` 為 `true`。若為 `false` 或訊息含 `shared libraries`，請改 Docker。

## Environment Variables

最少要設：

| 變數 | 說明 |
|------|------|
| `TZ_WHITELIST_ENABLED` | 第一次先 `false`，確認能登入後再改 `true` |
| `ADMIN_PASSWORD` | `/admin` 後台密碼，請用長且唯一的密碼 |
| `DATABASE_URL` | Render PostgreSQL 的 Internal Database URL（啟用白名單時必填） |

可選：

| 變數 | 說明 |
|------|------|
| `DG_CHROME_PATH` | 若機器已有 Chrome，可指定執行檔路徑 |
| `DG_CHROME_REQUIRE_SMOKE` | Docker build 已設為 `1`；Native 可省略 |
| `PORT` | Render 會自動給，不必自設 |

登入仍用 TZ／OFA 帳密；白名單帳號在 `/admin` 管理。

## 建議流程

1. 建 Render PostgreSQL（與 Web Service 同區域）。  
2. Web Service 的 `DATABASE_URL` 貼 Internal URL。  
3. `TZ_WHITELIST_ENABLED=false` 先部署並登入 `/admin`，把你的 TZ 帳號加進白名單。  
4. 再把 `TZ_WHITELIST_ENABLED` 改成 `true` 後 Redeploy。  
5. 實機登入後看歐博／DB；若失敗，看 Render Log 的 `[Vendor AB]`／`[Vendor DB]` 與 `/api/health`。

## 常見原因（本機／Agent 通、部署不通）

1. **沒裝到／開不起 Chrome** → 改 Docker + Clear build cache  
2. **記憶體不夠** → 歐博、DB 各開一個 Chromium；請用至少 1GB（建議 2GB）方案  
3. **伺服器代打 TZ 被擋** → 授權必須由瀏覽器取得（程式已優先走瀏覽器）  
