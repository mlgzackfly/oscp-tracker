# 資安檢視

對本專案做的一次白箱原始碼審查（前端 + `server/app.py` SQLite 後端），對照 OWASP Top 10 (2021)
與 API Security Top 10 (2023)。每一項都以實際 payload 或請求驗證過，不是只看程式碼推論。

檢視範圍：`web/`（瀏覽器端）、`server/app.py`（自架後端）、Docker 設定。
單檔／純靜態版沒有後端，攻擊面只有前端那半。

## 結論

沒有 High 以上的可利用弱點。最需要注意的是**部署層面**：帶資料庫的自架版預設沒有認證，
別直接暴露到公開網路。已修掉數個縱深防禦缺口。

## 發現與處置

| # | 項目 | OWASP | 嚴重度 | 狀態 |
| --- | --- | --- | --- | --- |
| 1 | 筆記/Markdown 渲染的 XSS | A03 注入 | — | ✅ 實測無法利用 |
| 2 | 後端 API 預設無認證，可能被暴露 | A01 / API1 | Medium（暴露時 High） | ⚠️ 設計取捨，已在文件標明 |
| 3 | 設了 `OSCP_TOKEN` 前端卻沒帶 token | A07 認證 | Medium（功能失效） | ✅ 已修 |
| 4 | token 比對非常數時間 | A02 | Low | ✅ 改用 `hmac.compare_digest` |
| 5 | 缺安全標頭（CSP 等） | A05 設定錯誤 | Low | ✅ 已補（nginx + python 皆有） |
| 6 | 錯誤回應外洩例外訊息 | A05 | Low | ✅ 改為通用訊息 |
| 7 | 無速率限制、執行緒無上限 | API4 | Info | ⚠️ 個人內網可接受，暴露時需前置反向代理 |
| 8 | 路徑穿越 | A01 | — | ✅ 實測擋下（`resolve()` + 父目錄檢查） |
| 9 | SQL 注入 | A03 | — | ✅ 全用參數化查詢 |
| 10 | CSRF | A01 | Low | ✅ 僅收 `application/json` 的 PUT，跨站表單無法觸發；無 CORS 標頭 |

### 1. XSS（最該擔心，因為是筆記工具）— 無法利用

筆記支援 Markdown，內容是使用者輸入，渲染成 HTML。實測注入 `<img onerror>`、`<script>`、
`[x](javascript:...)`、`<svg onload>` 與屬性逃逸 `[x](https://a" onmouseover="...)`：

- 渲染器先對全部內容 `esc()` 逐字轉義（`& < > "`），才套用 Markdown 標籤
- 連結強制 `https?://`，且 URL 進 `href` 前引號已被轉義，無法逃出屬性
- DOM 查詢確認：`realDangerEls=0`、`realHandlerAttrs=0`，沒有任何真實的危險元素或事件屬性被建立

### 2. 後端預設無認證（部署層最高風險）

帶資料庫的版本預設任何人都能讀寫 `/api/state`。這是刻意的取捨——個人內網／NAS 上用不該還要登入。
但**若把連接埠開到公開網路而沒設 token，任何人都能看光或竄改你的進度**。

處置：設 `OSCP_TOKEN` 環境變數即需認證（Bearer 標頭或 `?token=`）；公開部署務必加上，並建議前置
反向代理（TLS + 速率限制）。純靜態／單檔版沒有後端，不受此影響。

### 7. DoS

PUT body 上限 5 MB。無速率限制，`ThreadingHTTPServer` 每連線一條執行緒、無上限。個人用途可接受；
面向網路時請由反向代理（nginx/Caddy）擋速率與連線數。

## 沒有的東西（因此不在攻擊面）

沒有登入系統、沒有 cookie/session、沒有上傳、沒有 eval、沒有第三方 JS（只有 Google Fonts 的字型檔），
所有進度都在使用者自己的裝置或自架伺服器上。前端與後端同源，API 也沒有開 CORS。

## 重現

XSS 驗證與後端測試的指令都在本次 commit 訊息與 git 歷史中；後端可用
`OSCP_TOKEN=x PORT=8735 uv run python server/app.py` 起一份自行驗證標頭與認證。
