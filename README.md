# OSCP 靶機作戰台

以 LainKusanagi 的 OSCP-like machines 清單為基礎的練習追蹤器：記錄打過哪些靶機、隨機抽靶機、安排每週排程。

## 用法

```bash
python3 -m http.server 8731 --directory web
# 開 http://localhost:8731
```

進度存在瀏覽器 localStorage，換裝置前到「資料」分頁匯出 JSON 備份。

## 結構

- `data/lainkusanagi.xlsx` — 原始試算表
- `data/offsec_labs.tsv` — 從 OffSec portal 取得的 343 筆 Practice 靶機難度（name / level / OS / labType / id）
- `data/machines.json` / `web/data.js` — 解析後的靶機資料（445 台）
- `scripts/parse_sheet.py` — 試算表 → JSON
- `scripts/build_artifact.py` — 打包成單一 HTML（`dist/`）
- `web/` — 網站本體（vanilla JS，無建置流程）

重新解析：`uv run --with openpyxl python scripts/parse_sheet.py`（會自動併入 `offsec_labs.tsv` 的難度）

## 難度資料

難度取自 OffSec portal 的 Practice 實驗室（`level` 100/200/300/400 對應 Fundamental / Intermediate / Advanced / Insane），
只套用在 Proving Grounds 平台的靶機上——HackTheBox 有 Access、Escape、Heist 這類同名靶機，跨平台對名會配錯。

Proving Grounds Practice 必練 75 台的難度分布：Fundamental 14、Intermediate 54、Advanced 5，
另有 Hokkaido 與 Mice 兩台在 portal 上已查無資料（推測已下架）。

## 資料範圍

| 分頁 | 平台 | 數量 |
| --- | --- | --- |
| OSCP | Hackthebox | 79 |
| OSCP | **Proving Grounds Practice（必練）** | **75** |
| OSCP | Virtual Hacking Labs | 39 |
| OSCP | HackSmarter | 29 |
| OSCP | VulnLab / Hackthebox | 19 |
| OSCP | Proving Grounds Play | 10 |
| OSCP | Tryhackme（已停止更新） | 44 |
| Red Team | Hackthebox / PG / HackSmarter / VulnLab | 151 |

必練標記給的是 OSCP 分頁的 Proving Grounds Practice 區塊（Linux 49、Windows 17、AD 與網段 9）。
