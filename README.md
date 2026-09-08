# OSCP 靶機作戰台

離線可用的 OSCP 靶機練習追蹤器：記錄打過哪些靶機、隨機抽一台來打、安排每週排程。
靶機清單整理自 [LainKusanagi 的 OSCP-like machines 清單](https://docs.google.com/spreadsheets/d/18weuz_Eeynr6sXFQ87Cd5F0slOj9Z6rt/)（445 台），難度取自 OffSec portal。

> An offline-first tracker for the LainKusanagi OSCP-like machine list — log what you've
> pwned, draw a random box, plan your week. One HTML file, no server, no build step,
> no dependencies, no account.

![總覽](docs/overview.jpg)

## 怎麼跑起來

### 最快：一個檔案

下載 [`dist/oscp-tracker.html`](dist/oscp-tracker.html)，用瀏覽器打開。沒了。

沒有安裝步驟、沒有伺服器、沒有帳號。所有東西（含 445 台靶機資料）都在那一個檔案裡。

### 或者 clone 下來改

```bash
git clone <你的 repo 網址> && cd OPSC_track
open web/index.html          # macOS
xdg-open web/index.html      # Linux
start web\index.html         # Windows
```

`web/` 底下就是網站本體，改完存檔重新整理就看得到。如果你的瀏覽器擋掉本機檔案之間的載入，改用下面的方式。

### 想在手機或其他裝置上開

```bash
python3 -m http.server 8731 --directory web
```

同網段的裝置連 `http://<這台電腦的 IP>:8731` 就行。要放到網路上的話，這是純靜態網站，
丟進 GitHub Pages、Netlify、Cloudflare Pages 或任何靜態空間都可以，`dist/oscp-tracker.html`
單檔上傳也行。

## 這東西吃多少資源

沒有後端、沒有資料庫、沒有建置流程、沒有 npm。整包就是三個靜態檔加一份 128 KB 的靶機資料，
除了瀏覽器分頁本身以外不佔用任何東西。唯一的外部請求是 Google Fonts 的字型檔；
離線開一樣能用，只是字型換成系統字型。

## 進度存在哪、怎麼不弄丟

進度預設存在瀏覽器的 localStorage，**沒有任何資料離開你的電腦**——但這也表示清快取、換瀏覽器、
換電腦都會讓它消失。OSCP 準備動輒三個月起跳，所以「資料」分頁提供了兩層保險：

- **接上本機檔案（建議）** — 選一個備份檔位置，之後每次改動都自動寫進去。
  把它放在 iCloud Drive、Dropbox、Google Drive 這類會同步的資料夾裡，換電腦時在新機器上接同一個檔案再讀回來就行。
  需要 Chrome、Edge 等 Chromium 瀏覽器（File System Access API）。
- **手動備份** — 隨時下載 JSON、從檔案還原，或複製／貼上 JSON。Firefox、Safari 只能走這條。

超過七天沒備份時，總覽頁會直接提醒你。

### 為什麼不用資料庫

自架版刻意不接資料庫：一有資料庫就得有伺服器、要維運、要備份，跟「下載一個檔案就能跑」直接衝突。
本機檔案自動寫入已經涵蓋了資料庫在這裡的用途——持久、可帶走、可放進雲端同步。

發佈成 Claude Artifact 的版本則會自動接上該 artifact 專屬的雲端資料庫（`db` capability）：
同一個帳號在任何裝置開同一個連結都是同一份進度，清快取也不影響。合併是逐台比對時間戳做的，
兩台裝置各打各的不會互相蓋掉。想要跨裝置又不想自己架東西，用那個版本。

## 功能

- **備考期程** — 設定開始、考試與方案到期日，總覽會顯示考試倒數、時間軸，以及「時間過了多少 vs 必練完成多少」的落差，還有考前打完必練所需的每週台數。考試日和到期日是分開的欄位——有些方案一年內能考兩次
- **計時器** — 開打前按開始，結束按停止，時數自動累加到那台機器，計時中的機器固定顯示在側邊欄
- **卡關分類** — 每台可標記卡在枚舉偵察／初始立足點／提權／橫向移動／紀錄報告哪個階段（可複選），
  累積幾台之後總覽會排出你的弱點分布。打了一堆機器卻不知道自己弱在哪，是備考最常見的浪費
- **每週節奏圖** — 近 12 週每週完成台數，虛線是「考前打完必練所需的每週台數」，
  長條低於虛線就是跟不上；滑過任一週看該週的台數與時數
- **筆記** — 側邊欄獨立分頁，把所有動過的靶機集中管理：左側清單（有筆記的排前面，圓點外圈表示已有筆記、內色是狀態），
  右側編輯器支援 Markdown（可切「寫／預覽」看渲染結果）、標卡關階段、放 writeup 連結、一鍵插入模板，也能刪除筆記
- **匯出 Markdown** — 把進度、期程、卡關分布與所有靶機筆記匯成一份 .md，可以直接當 writeup 索引
- **總覽** — Proving Grounds Practice 必修完成度、各平台進度、本週完成數與連續打靶天數、今日排程
- **靶機清單** — 445 台依平台分組，可用平台／系統／難度／狀態篩選與搜尋；每台可記錄耗時、難度自評、writeup 連結與筆記
- **抽靶機** — 從候選池隨機抽一台，預設鎖定還沒打完的必練 PG 機器，可再限定系統與難度
- **排程** — 週視圖，手動排入或一鍵自動排本週 5 台
- **資料** — 接上本機備份檔自動寫入，或手動下載／還原 JSON

![靶機清單](docs/machines.jpg)

## 資料從哪來

| 檔案 | 內容 |
| --- | --- |
| `data/lainkusanagi.xlsx` | 原始試算表（Google Sheets 匯出） |
| `data/offsec_labs.tsv` | OffSec portal 的 343 筆 Practice 靶機難度（名稱／等級／OS／類型／ID） |
| `data/machines.json` | 解析合併後的 445 台靶機 |
| `web/data.js` | 同上，包成瀏覽器直接載入的形式 |

難度等級 100/200/300/400 對應 Fundamental / Intermediate / Advanced / Insane，
**只套用在 Proving Grounds 平台**——HackTheBox 也有 Access、Escape、Heist 這類同名靶機，跨平台對名會配錯。

Proving Grounds Practice 必練 75 台的難度分布：Fundamental 14、Intermediate 54、Advanced 5；
另有 Hokkaido 與 Mice 兩台在 portal 上已查無資料，推測已下架。

## 重新產生資料

只有要更新靶機清單時才需要 Python，平常用不到。

```bash
uv run --with openpyxl python scripts/parse_sheet.py   # xlsx + tsv → data/machines.json、web/data.js
uv run python scripts/build.py                          # web/ → dist/ 單檔版
```

`data/offsec_labs.tsv` 是從 OffSec portal 的搜尋 API 取得的，格式為 `名稱\t等級\tOS\t類型\tID`，
手動維護或重新抓取都可以，`parse_sheet.py` 會自動併入。

## 專案結構

```
web/            網站本體（vanilla JS，無框架、無建置流程）
  index.html
  styles.css
  app.js
  data.js       產生物，已 commit，這樣不用跑 Python 就能直接用
dist/           單檔版（產生物）
data/           原始與解析後的資料
scripts/        資料解析與打包腳本
docs/           README 用的截圖
```

## 免責

**這份清單和難度分級只是練習參考，不是考古題也不是保證。**

清單是 LainKusanagi 依個人備考經驗整理的，難度是 OffSec 對自家靶機的標記，兩者都不代表 OSCP 的考試內容。
全部打完仍可能沒通過，沒全部打完也可能通過；真正決定結果的是你的方法論、枚舉的完整度、時間控制與報告品質。
靶機也會下架或改版（例如 Hokkaido、Mice 已從 portal 消失），清單有時效性，一切以各平台當下的實際狀況為準。

這個工具只幫你記錄進度，不會讓你變強，也不對你的考試結果負任何責任。

## 授權

程式碼採 [MIT](LICENSE)。

靶機清單由 LainKusanagi 整理並公開分享，難度分級是 OffSec 的產品資訊，
兩者著作權皆屬原作者所有；本專案只是把它們整理成方便練習追蹤的形式。
清單原始出處與作者的其他資源請見試算表本身。
