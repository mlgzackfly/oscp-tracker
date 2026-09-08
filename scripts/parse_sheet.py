"""Parse LainKusanagi's OSCP machine list spreadsheet into structured JSON."""
import json
import re
import sys
from pathlib import Path

import openpyxl

SRC = Path("data/lainkusanagi.xlsx")
LABS = Path("data/offsec_labs.tsv")
OUT_JSON = Path("data/machines.json")
OUT_JS = Path("web/data.js")

LEFT = (0, 1, 2, 3)
RIGHT = (4, 5, 6, 7)

SECTION_WHITELIST = {
    "AWS (Not in the exam)",
    "AWS (Wip)",
    "AWS",
    "Treat it like a small network",
    "Recommended paths",
}

SKIP_TITLES = {"Update:", "Other recommended rooms"}

NOTE_RE = re.compile(r"\s*\(([^)]*)\)\s*$")
DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}")


def cell(row, idx):
    value = row[idx] if idx < len(row) else None
    return value.strip() if isinstance(value, str) else None


def is_header(row, cols):
    return cell(row, cols[0]) == "Linux" and cell(row, cols[1]) == "Windows"


def is_section(text):
    return text.endswith(":") or text in SECTION_WHITELIST


def split_note(name):
    match = NOTE_RE.search(name)
    if not match:
        return name, None
    return NOTE_RE.sub("", name).strip(), match.group(1).strip()


def find_title(rows, header_idx, col):
    """Walk upwards past the long blurb paragraph to reach the block title."""
    for idx in range(header_idx - 1, -1, -1):
        text = cell(rows[idx], col)
        if not text:
            continue
        if len(text) > 80 or len(text.split()) > 5:
            continue
        return text, idx
    return "Unknown", header_idx


def parse_block(rows, header_idx, cols, sheet, entries):
    platform, _ = find_title(rows, header_idx, cols[0])
    if platform in SKIP_TITLES:
        return
    categories = {c: cell(rows[header_idx], c) for c in cols}
    section = {c: None for c in cols}

    for row in rows[header_idx + 1 :]:
        if is_header(row, cols):
            break
        for col in cols:
            text = cell(row, col)
            if not text:
                continue
            if len(text) > 80 or DATE_RE.match(text):
                continue
            if is_section(text):
                section[col] = None if text in SKIP_TITLES else text.rstrip(":")
                continue
            if section[col] == "Update":
                continue
            name, note = split_note(text)
            entries.append(
                {
                    "sheet": sheet,
                    "platform": platform,
                    "category": categories[col] or "Other",
                    "section": section[col],
                    "name": name,
                    "note": note,
                }
            )


def block_end(rows, header_idx, cols):
    """A block runs until the title row that introduces the next block."""
    for idx in range(header_idx + 1, len(rows)):
        if is_header(rows[idx], cols):
            return find_title(rows, idx, cols[0])[1]
    return len(rows)


LEVELS = {"100": "Fundamental", "200": "Intermediate", "300": "Advanced", "400": "Insane"}


def offsec_labs():
    """Difficulty ratings scraped from the OffSec portal, keyed by squashed name."""
    if not LABS.exists():
        return {}
    table = {}
    for line in LABS.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) >= 5:
            table[parts[0].lower().replace(" ", "")] = parts
    return table


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    entries = []
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        for cols in (LEFT, RIGHT):
            for idx, row in enumerate(rows):
                if is_header(row, cols):
                    sliced = rows[: block_end(rows, idx, cols)]
                    parse_block(sliced, idx, cols, ws.title, entries)

    seen = set()
    machines = []
    for entry in entries:
        key = (entry["sheet"], entry["platform"], entry["category"], entry["name"])
        if key in seen:
            continue
        seen.add(key)
        entry["id"] = "{}|{}|{}".format(
            "oscp" if entry["sheet"] == "OSCP List" else "redteam",
            entry["platform"],
            entry["name"],
        )
        entry["track"] = "OSCP" if entry["sheet"] == "OSCP List" else "Red Team"
        entry["required"] = entry["track"] == "OSCP" and entry["platform"] == "Proving Grounds Practice"
        machines.append(entry)

    labs = offsec_labs()
    matched = 0
    for m in machines:
        # Only Proving Grounds shares a namespace with the portal; HTB reuses names like Access.
        if "Proving Grounds" not in m["platform"]:
            continue
        row = labs.get(m["name"].lower().replace(" ", ""))
        if not row:
            continue
        matched += 1
        m["level"] = row[1]
        m["difficulty"] = LEVELS.get(row[1], row[1])
        m["labType"] = row[3]
        m["offsecId"] = row[4]

    payload = {"source": "LainKusanagi OSCP-like machines list", "machines": machines}
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    OUT_JS.write_text("window.OSCP_DATA = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n")

    print(f"total {len(machines)} · 難度已標記 {matched}")
    from collections import Counter
    for track in ("OSCP", "Red Team"):
        counts = Counter(m["platform"] for m in machines if m["track"] == track)
        print(f"-- {track}")
        for platform, n in counts.items():
            print(f"   {platform}: {n}")


if __name__ == "__main__":
    sys.exit(main())
