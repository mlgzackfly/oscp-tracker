"""用 Playwright 截無損 PNG 宣傳圖（淺色模式、示範資料、2x retina）。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8731/index.html"
OUT = Path("docs/promo")
OUT.mkdir(parents=True, exist_ok=True)

SEED = r"""
(() => {
  const req = window.OSCP_DATA.machines.filter(m => m.required);
  const day = n => { const d=new Date('2026-09-09T20:00:00'); d.setDate(d.getDate()-n); return d.toISOString(); };
  const dateStr = n => { const d=new Date('2026-09-09'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
  const entries = {};
  const offs=[0,0,1,1,2,3,3,4,5,6,7,8,10,11,12,14,15,17,19,21];
  const ph=[['recon'],['privesc'],['privesc','recon'],['foothold'],['privesc'],['lateral'],['privesc'],['recon'],['report'],['foothold']];
  const notes=[
    '## 枚舉\n- 80/tcp 舊版 **CMS**，作者路徑遍歷\n- `gobuster` 找到 /admin\n\n## 提權\n- sudo 誤設，用 [GTFOBins](https://gtfobins.github.io) 提到 root\n\n## 學到什麼\n- 舊版 CMS 先查 CVE',
    '## 枚舉\n- SMB 匿名可讀，撈到備份檔\n\n## 提權\n- 服務以 SYSTEM 執行，DLL 側載',
    'AD：拿到低權帳號後 BloodHound 找到 GenericAll，改密碼橫移',
  ];
  req.slice(0,20).forEach((m,i)=>{ entries[m.id]={status:'done',minutes:[120,150,90,240,180,105,200,135][i%8],rating:['剛好','偏易','偏難','剛好','很簡單'][i%5],notes:notes[i]||'',noteDone:i<2,doneAt:day(offs[i]),date:null,url:i===0?'https://0xdf.gitlab.io/clamav':'',phases:ph[i%10],updatedAt:day(offs[i])}; });
  entries[req[20].id]={status:'active',minutes:75,rating:'',notes:'反序列化卡住，payload 版本要對',noteDone:false,doneAt:null,date:dateStr(0),url:'',phases:['foothold'],updatedAt:day(0)};
  entries[req[21].id]={status:'active',minutes:40,rating:'',notes:'',doneAt:null,date:dateStr(0),url:'',phases:[],updatedAt:day(0)};
  entries[req[22].id]={status:'stuck',minutes:210,rating:'打不動',notes:'',doneAt:null,date:dateStr(-1),url:'',phases:['privesc'],updatedAt:day(1)};
  [23,24,25].forEach((n,i)=>{ entries[req[n].id]={status:'todo',minutes:0,rating:'',notes:'',doneAt:null,date:dateStr(i+1),url:'',phases:[],updatedAt:day(1)}; });
  localStorage.setItem('oscp-track-v1', JSON.stringify({entries,history:req.slice(20,25).map(m=>m.id),theme:'light',plan:{start:'2026-06-01',exam:'2026-11-20',end:'2027-01-31'},updatedAt:new Date().toISOString()}));
  localStorage.setItem('oscp-track-meta', JSON.stringify({lastBackupAt:new Date().toISOString(),fileName:'oscp-tracker-backup.json'}));
})();
"""

def shoot(page, name, setup=None):
    if setup:
        page.evaluate(setup)
        page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / f"light-{name}.png"))
    print("saved", OUT / f"light-{name}.png")

with sync_playwright() as p:
    browser = p.chromium.launch()

    # 桌面 2x retina
    ctx = browser.new_context(viewport={"width": 1440, "height": 810}, device_scale_factor=2)
    page = ctx.new_page()
    page.goto(BASE); page.evaluate(SEED); page.reload(); page.wait_for_timeout(700)
    shoot(page, "overview")
    shoot(page, "machines", "document.querySelector('#nav button[data-view=\"machines\"]').click(); document.querySelector('#f-required').click();")
    shoot(page, "notes", "document.querySelector('#nav button[data-view=\"notes\"]').click(); setTimeout(()=>{document.querySelectorAll('.note-item')[2]?.click(); setTimeout(()=>document.querySelector('[data-act=\"note-mode\"][data-mode=\"preview\"]')?.click(),150);},150);")
    shoot(page, "draw", "document.querySelector('#nav button[data-view=\"draw\"]').click(); document.querySelector('#btn-draw')?.click();")
    shoot(page, "schedule", "document.querySelector('#nav button[data-view=\"schedule\"]').click();")
    ctx.close()

    # 手機 2x
    ctx = browser.new_context(viewport={"width": 430, "height": 860}, device_scale_factor=2, is_mobile=True)
    page = ctx.new_page()
    page.goto(BASE); page.evaluate(SEED); page.reload(); page.wait_for_timeout(700)
    page.evaluate("document.querySelector('#nav button[data-view=\"overview\"]').click(); window.scrollTo(0,0);")
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "light-mobile.png"))
    print("saved", OUT / "light-mobile.png")
    ctx.close()
    browser.close()
