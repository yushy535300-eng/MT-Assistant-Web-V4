# 歐博／DB 部署修正包

把壓縮檔內檔案覆蓋到你的 `MT-Assistant-Web-V3` 專案對應路徑，再推到 GitHub 部署。

## 覆蓋後部署（建議 Docker）

1. Render → Web Service → Runtime 選 **Docker**
2. 勾 **Clear build cache & deploy**
3. 環境變數照 `RENDER_DEPLOY.md`
4. 部署後打開：`https://你的網域/api/health`
5. 確認 `chrome.available` 為 `true`

## 這包不會改

懸浮球、算牌 V38、奇偶、MT／DG 進桌流程都沒動。
