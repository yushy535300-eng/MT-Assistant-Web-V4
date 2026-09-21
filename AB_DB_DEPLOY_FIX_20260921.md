# 歐博／DB 部署連線修正（2026-09-21）

本機／Cloud Agent 測得通、Render 部署後歐博與 DB 都連不上的修正。

## 根因

1. 背景 Chromium 啟動失敗時，後端只寫 log，前端一直停在「連線中」。
2. Render Native Node 常缺 Chrome 系統函式庫，解 `.deb` 後仍無法啟動。
3. 登入後歐博、DB 同時開兩個 Chrome，低記憶體方案容易 OOM。
4. 授權請求先前先打匿名再帶 token，部分情況下會誤判授權失敗。
5. 授權失效後伺服器代打 TZ（Render IP）常被擋。

## 已修正

- Chromium 啟動失敗會設成明確「連線失敗」並回傳 API 錯誤。
- Chrome 啟動加鎖，避免歐博／DB 同時搶開。
- 前端 DB 連線延後 8 秒，降低記憶體尖峰。
- 瀏覽器取得授權改為優先帶 platform token。
- `/api/health`、`/api/vendor/chrome` 回報 Chrome 是否可用。
- `postinstall` 增加 Chrome smoke test；缺函式庫時提示改 Docker。
- 新增 `Dockerfile`（含 Chrome 相依套件）；`RENDER_DEPLOY.md` 改以 Docker 為建議路徑。
- 歐博 6076／授權失效時，不再死磕伺服器代打 TZ，改提示重新整理。

## 部署

**請改用 Docker Web Service**，並勾 **Clear build cache & deploy**。

部署後檢查：

```text
https://你的網域/api/health
```

`chrome.available` 必須為 `true`。
