# MT Assistant｜歐博＋DB 四平台整合

- 基準：完整牌面與電腦拖曳修正版 V4；MT、DG 原連線流程不重寫。
- 主頁平台：MT、DG、歐博、DB。
- 歐博分類：一般（預設）、快速、免佣、保險、VIP、所有。
- DB 分類：一般（預設）、終極、完美、共贏、包桌、電投、所有。
- 分類僅篩選既有桌台快照，不會重登、重連或清空牌路。
- 歐博按實際 HAR 解析 getGameHall、pushGameStatus、pushRawCards、pushPayoutInfo 與 betLog。
- 歐博牌面保留莊閒各最多三張；`-1` 視為沒有第三張。
- DB 使用真實啟動頁完成動態解密後再擷取資料，不寫死 HAR token 或金鑰。
- 四平台的桌台、連線狀態、分類及今日輸贏狀態彼此隔離。
- 懸浮算牌與奇偶沿用同一份目前平台牌面。

驗證：

- 前端與後端均已通過 esbuild bundle 語法／依賴邊界檢查。
- HAR 牌值、勝負、桌型分類共 8 項解析斷言通過。
- 原專案 lockfile 缺少既有 pg 套件 integrity，因此此環境的 pnpm 完整安裝政策檢查會先於專案測試中止；未修改 lockfile。
