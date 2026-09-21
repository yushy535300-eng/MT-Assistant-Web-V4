# 歐博／DB 連線與離線桌框修正

本版修正主頁切換歐博或 DB 後長時間顯示「連線中、0 桌」且整頁沒有桌框的問題。

## 已修正

- 歐博授權網址改為驗證 `sessionId`，不再錯誤要求 `token`。
- DB 授權網址改為驗證加密 `params`，不再錯誤要求 `token`。
- `pnpm install` 會自動安裝背景即時資料所需的 Chromium。
- 歐博增加 CDP WebSocket 文字封包備援擷取，包含由 Worker 建立的連線。
- 即時資料未連線或暫時中斷時，桌台牌路框仍會顯示。
- 歐博離線桌框使用實際 HAR 桌號及分類。
- DB 離線桌框依大廳分類建立；連線後會由真實桌台資料替換。
- 連線失敗會明確顯示「連線失敗」，不再一直停留在「連線中」。

## 部署

必須觸發一次完整的 **Clear build cache & deploy / 重新 Build**。只重啟舊服務不會執行新增的 `postinstall`，也就不會安裝 Chromium。

Render Build Command：

```bash
pnpm install --frozen-lockfile && pnpm build
```

Render Start Command：

```bash
pnpm start
```
