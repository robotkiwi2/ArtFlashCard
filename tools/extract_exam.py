# -*- coding: utf-8 -*-
"""기출문제 PDF 에서 문항별 이미지를 잘라 exam/<id>/qNN.png 와 exam/index.json 을 만든다.

    python tools/extract_exam.py 2026A

문항 영역은 EXAMS 에 손으로 적는다 (page, col, y0, y1). col: L/R/F(전면).
PDF 는 2단 조판이라 자동 분할이 믿을 만하지 않아, 블록 좌표를 보고 정한 값이다.
"""
import io, json, os, re, sys
import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(os.path.dirname(ROOT), "미술전공", "기출문제")
OUT = os.path.join(ROOT, "exam")
ZOOM = 2.0
COLS = {"L": (78, 420), "R": (422, 768), "F": (78, 768)}

EXAMS = {
    "2026A": {
        "title": "2026학년도 전공A",
        "pdf": "2026_미술_2a.pdf",
        "questions": [
            # (번호, [(page, col, y0, y1), ...])  page 는 1부터
            (1,  [(1, "L", 335, 900)]),
            (2,  [(1, "R", 277, 958)]),
            (3,  [(2, "F", 137, 536)]),
            (4,  [(3, "L", 137, 448)]),
            (5,  [(3, "L", 603, 912)]),
            (6,  [(3, "R", 137, 827)]),
            (7,  [(4, "F", 137, 708)]),
            (8,  [(4, "F", 734, 1058)]),
            (9,  [(5, "L", 137, 844)]),
            (10, [(5, "R", 137, 562)]),
            (11, [(6, "F", 137, 813)]),
            (12, [(7, "F", 137, 678)]),
        ],
    },
}

def first_line(page, col, y0):
    x0, x1 = COLS[col]
    txt = page.get_text("text", clip=pymupdf.Rect(x0, y0, x1, y0 + 40))
    line = " ".join(txt.split())
    m = re.match(r"^(\d{1,2})\.\s*(.*)$", line)
    return (m.group(2) if m else line)

def points_of(page, segs):
    for (pg, col, y0, y1) in segs:
        x0, x1 = COLS[col]
        txt = page.parent[pg - 1].get_text("text", clip=pymupdf.Rect(x0, y0, x1, y1))
        m = re.search(r"\[(\d+)점\]", txt)
        if m: return int(m.group(1))
    return None

def render(doc, segs):
    from PIL import Image
    tiles = []
    for (pg, col, y0, y1) in segs:
        x0, x1 = COLS[col]
        pix = doc[pg - 1].get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=pymupdf.Rect(x0, y0, x1, y1), alpha=False)
        tiles.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
    w = max(t.width for t in tiles); h = sum(t.height for t in tiles)
    out = Image.new("RGB", (w, h), "white")
    y = 0
    for t in tiles:
        out.paste(t, (0, y)); y += t.height
    return out

def main(ids):
    idx_path = os.path.join(OUT, "index.json")
    index = json.load(io.open(idx_path, encoding="utf-8")) if os.path.exists(idx_path) else []
    for eid in ids:
        spec = EXAMS[eid]
        doc = pymupdf.open(os.path.join(PDF_DIR, spec["pdf"]))
        os.makedirs(os.path.join(OUT, eid), exist_ok=True)
        qs = []
        for n, segs in spec["questions"]:
            img = render(doc, segs)
            rel = f"exam/{eid}/q{n:02d}.jpg"
            img.save(os.path.join(ROOT, rel), "JPEG", quality=88, optimize=True)
            pg, col, y0, _ = segs[0]
            qs.append({"n": n, "points": points_of(doc[pg - 1], segs), "text": first_line(doc[pg - 1], col, y0)[:80], "img": rel})
            print(f"{eid} q{n:02d}: {img.width}x{img.height}  [{qs[-1]['points']}점] {qs[-1]['text'][:40]}")
        entry = {"id": eid, "title": spec["title"], "count": len(qs), "questions": qs}
        index = [e for e in index if e["id"] != eid] + [entry]
    index.sort(key=lambda e: e["id"], reverse=True)
    io.open(idx_path, "w", encoding="utf-8", newline="\n").write(json.dumps(index, ensure_ascii=False, indent=1))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or list(EXAMS)))
