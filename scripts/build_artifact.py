"""Bundle web/ into a single self-contained HTML page for publishing."""
from pathlib import Path

WEB = Path("web")
OUT = Path("dist/oscp-tracker.html")

html = (WEB / "index.html").read_text()
body = html.split("<!-- APP:START -->")[1].split("<!-- APP:END -->")[0]
fonts = [line for line in html.splitlines() if "fonts.googleapis.com/css2" in line][0].strip()

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(
    "<title>OSCP 靶機作戰台</title>\n"
    f"{fonts}\n"
    f"<style>\n{(WEB / 'styles.css').read_text()}</style>\n"
    f"{body}\n"
    f"<script>\n{(WEB / 'data.js').read_text()}</script>\n"
    f"<script>\n{(WEB / 'app.js').read_text()}</script>\n"
)
print(OUT, OUT.stat().st_size, "bytes")
