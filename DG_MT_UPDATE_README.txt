MT Assistant｜MT + DG 整合修正版

本版修改重點
1. 登入面板維持原版，不新增 MT / DG 選擇。
2. TZ 登入成功後預設進入 MT，並沿用原本 MT 自動連線。
3. 牌路主頁原「可用桌型」區改為 MT / DG 平台切換，並保留「可用 X 桌」。
4. 切換 DG 後自動向本次登入的平台取得 DGLI 授權網址，不需手動貼 token / sign。
5. DG WebSocket 改由 Node 後端 relay 建立，保留 DG 要求的 Origin，再用同源 SSE 傳回前端；不再由瀏覽器直接硬連 vendor WSS。
6. DG 即時資料採 Binary Protobuf 解碼，支援桌號、荷官、Shoe、局號、倒數、歷史牌路、發牌牌面與直播網址。
7. DG 牌路直接沿用 MT 原本 TableCard + RoadGrid 版型與格數，只切換為 DG 黑金主題。
8. DG 尚未連線或可用桌數為 0 時，仍會先顯示完整 DG 桌卡與空白牌路模板，不再整頁空白。
9. 懸浮助理跟隨目前平台：MT 吃 MT 資料、DG 吃 DG 資料；選桌、分析、雷達與算牌共用目前平台資料。
10. 「進入平台」依目前選擇開啟 MT 或 DG；登出後平台重置為 MT。

主要新增/修改
- app/index.tsx：MT/DG 切換、DG 空模板、平台同步、DG 自動授權。
- lib/dg-live.ts：前端改走同源 DG relay/SSE。
- server/dg-relay.ts：DG Origin-aware WebSocket、3DES sign、Protobuf、重連與桌況正規化。
- server/_core/index.ts：/api/dg/start、/api/dg/stream、/api/dg/stop。
- server/routers.ts：DG relay 使用既有授權 session 驗證。

驗證
- 3DES sign 已用 HAR 中實際 token/sign 離線比對一致。
- 初始 DG WebSocket 指令序列與 HAR 比對：10086 → 45 → 2 → 5011 → 87 → 24。
- 修改過的 TS/TSX 檔已做語法轉譯檢查。

注意
- DG token/sign 均為每次登入動態取得，沒有把 HAR 裡的使用者 token 寫死。
- 本執行環境無法對 DG 外部 WSS 完成實際 DNS/外網連線，因此最終線上握手需以部署到 Render 後的實機測試為準；程式已保留具體連線狀態/錯誤訊息供定位。
