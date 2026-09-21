# 百家樂牌路正式規則查證

## 來源

1. Wizard of Odds, [Baccarat Score Boards](https://wizardofodds.com/games/baccarat/history/)。
2. WGM, [Baccarat's Roads Explained](https://wgm8.com/baccarat%CA%BCs-roads%CB%AE-explained/)。
3. Baccarat Smart, [How to Read Baccarat Roads](https://baccaratsmart.com/blog/how-to-read-baccarat-roads)。

## 已交叉確認的規則

- 珠盤路以每局一格記錄莊、閒、和；固定六列，由上往下填滿後才往右新欄。和局佔用一格。
- 大路僅依莊、閒建立柱；同邊往下，不同邊於最上方開新欄。和局不開新格，而是附記於前一個莊／閒結果。超過六列或下方格被先前龍尾佔用時，向右轉。
- 大眼仔、小路、曱甴路均是從大路推導的紅／藍規律，紅藍不代表莊／閒。三者回看距離分別為一欄、兩欄、三欄。
- 衍生路在大路新欄時，依已完成前欄與回看欄的深度是否相等判定紅／藍；在同欄向下時，依回看欄的目標列與其上一列是否同為已填或同為空白判定紅／藍。空白與空白也屬一致，判定紅。
- 大眼仔於大路第二欄第二格或第三欄第一格後開始；小路於第三欄第二格或第四欄第一格後開始；曱甴路於第四欄第二格或第五欄第一格後開始。
- 三種下三路自身也遵循六列高、連色向下、底部或碰撞後向右轉的龍尾落點。

## 實作限制

原資料 `bead_plate2` 僅帶莊、閒、和結果，未證實含 pair、natural 等附註；因此第一輪實作只處理結果與和局附記，不虛構未提供的側注標記。
