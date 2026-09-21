MT Assistant｜DG 後端中繼修正版

本版針對使用者提供的 mt-assistant-web-v3.onrender.com HAR 修正：
- 網頁版完全停用瀏覽器直連 DG WebSocket。
- DG WebSocket 改由 Render 後端中繼建立，握手 Origin 使用 DG 真正啟動頁 Origin。
- 先解析 direct1 / index 啟動頁與 type，再讀取 DG game_settings.json 選 WSS。
- WSS 候選線失敗會自動切線；若啟動頁解析出不同 Origin，也會再用另一個 DG Origin 重試。
- 前端只透過同網域 /api/dg/start + SSE /api/dg/stream 接收桌況，不會再出現瀏覽器對 newappa*.ywjxi.com / appatw.kindlestone.com 的直接 WSS。
- Render Logs 新增 DG 連線階段紀錄（不輸出 token/sign），方便直接看：啟動頁、WSS、Origin、101、驗證、真人桌數或握手錯誤。
- MT 原本連線、登入、牌路介面不更動。

部署後預期：
1. 切到 DG。
2. Network 的 WS 不應再看到瀏覽器直接連 newappa*/appatw。
3. Render Logs 會出現 [DG API] / [DG relay]。
4. 成功時依序看到 WebSocket 101 → 驗證完成 → 已同步真人桌 N 桌。

注意：是否能從 Render 出口 IP 抵達 DG WSS 仍需部署環境實測；本版已移除目前 HAR 證明會因瀏覽器 Origin 錯誤而失敗的直連路徑。
