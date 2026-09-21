# 即時事件封包證據

以下內容由使用者於原 MT 平台登入後的 WebSocket 開發者工具提供；敏感 Token 不保存。

| 事件 | 已確認欄位與用途 |
|---|---|
| `/api/v1/authenticate` | `err: 0` 表示以登入後 MT 平台網址的 `token` 參數取得牌路授權成功。 |
| `/tablesvg` | 回覆資料位於 `msg.tables.tables`；單次回覆可能僅含部分 BAG 桌，不能用回覆數量縮減15桌訂閱。 |
| `/mulitple_join` | `GET`，服務端實際拼字為 `mulitple_join`，回覆 `err: 0` 表示訂閱已接受。 |
| `/table/*/wait` | `POST body` 含 `table_id`、`shoe`、`round`、`count`；僅更新對應 BAG 桌等待狀態與局號，不能當作結果。 |
| `/table/*/end` | `POST body` 含 `table_id`、`shoe`、`round`；僅更新對應 BAG 桌結束狀態，不能當作結果。 |
| `/table/*/show_win` | `POST body` 含 `table_id`、`shoe`、`round`、`winner`；百家樂牌路唯一已確認的結果來源。`winner 1=閒`、`2=莊`、`3=和`。 |
| `/table/*/show_poker` | 已見 DTG02 非 BAG 桌，body 為 `result: [0,0,0,0]`、`table_id`、`shoe`、`round`，沒有 winner；不可寫入15桌百家樂牌路。 |
| `/table/*/betinfo` | 已收到事件名稱，但尚未取得可用結果欄位；僅作桌台階段狀態，不寫入牌路。 |

## 已驗證的桌台事件例子

- `wait`：BAG01、BAG03、BAG05、BAG09、BAG10、BAG11、BAG13A、BAG15。
- `end`：BAG13。
- `show_win`：BAG03，`shoe=17035`、`round=31`、`winner=2`，對應莊。

## 正確資料流程

1. 使用者登入 MT 平台並取得含 `?token=` 的登入後平台網址。
2. 網站從該網址提取 token 送出 authenticate。
3. authenticate 成功後，以 POST `/tablesvg` 取得現況並固定訂閱15桌 BAG。
4. wait/end 更新桌台狀態；show_win 才追加對應桌的莊、閒或和並以 tablesvg 校正。
