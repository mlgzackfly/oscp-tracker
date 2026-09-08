"""Bundle web/ into single-file builds.

  dist/oscp-tracker.html  standalone page — open it straight from the filesystem
  dist/artifact.html      body-only fragment for publishing as a Claude Artifact
"""
from pathlib import Path

WEB = Path("web")
DIST = Path("dist")
TITLE = "OSCP 靶機作戰台"

html = (WEB / "index.html").read_text()
body = html.split("<!-- APP:START -->")[1].split("<!-- APP:END -->")[0]
head = html.split("<head>")[1].split("</head>")[0]
fonts = [line for line in head.splitlines() if "fonts.googleapis.com/css2" in line][0].strip()
favicon = [line for line in head.splitlines() if 'rel="icon"' in line][0].strip()

style = f"<style>\n{(WEB / 'styles.css').read_text()}</style>"
scripts = f"<script>\n{(WEB / 'data.js').read_text()}</script>\n<script>\n{(WEB / 'app.js').read_text()}</script>"

DIST.mkdir(exist_ok=True)

(DIST / "oscp-tracker.html").write_text(
    f"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{TITLE}</title>
{favicon}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
{fonts}
{style}
</head>
<body>
{body}
{scripts}
</body>
</html>
"""
)

(DIST / "artifact.html").write_text(f"<title>{TITLE}</title>\n{fonts}\n{style}\n{body}\n{scripts}\n")

for f in ("oscp-tracker.html", "artifact.html"):
    print(f"dist/{f}", (DIST / f).stat().st_size, "bytes")
