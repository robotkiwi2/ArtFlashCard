# -*- coding: utf-8 -*-
"""기출문제 PDF 에서 문항별 이미지를 잘라 exam/<id>/qNN.png 와 exam/index.json 을 만든다.

    python tools/extract_exam.py 2026A

문항 영역은 exam_segments.auto_segments 가 문항 머리 위치로 자동으로 잡는다.
결과가 어긋나는 시험지는 EXAMS 에 "questions" 로 (page, col, y0, y1) 을 손으로 적어 덮어쓴다. col: L/R/F(전면).
"""
import io, json, os, re, sys
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exam_segments import auto_segments

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
    "2026B": {
        "title": "2026학년도 전공B",
        "pdf": "2026_미술_3b.pdf",
        "questions": [
            (1,  [(1, "F", 335, 565)]),
            (2,  [(1, "F", 565, 1050)]),
            (3,  [(2, "L", 137, 556)]),
            (4,  [(2, "R", 137, 1057)]),
            (5,  [(3, "F", 137, 692)]),
            (6,  [(3, "F", 692, 1064)]),
            (7,  [(4, "L", 137, 810)]),
            (8,  [(4, "R", 137, 595)]),
            (9,  [(5, "L", 137, 841)]),
            (10, [(5, "R", 137, 1020)]),
            (11, [(6, "F", 137, 700)]),
        ],
    },
    "2025A": {
        "title": "2025학년도 전공A",
        "pdf": "2025미술A.pdf",
        "text": False,   # 이 PDF 는 글꼴 매핑이 깨져 추출 텍스트를 쓸 수 없다 (이미지는 정상)
        "questions": [
            (1,  [(1, "L", 334, 857)]),
            (2,  [(1, "R", 277, 1035)]),
            (3,  [(2, "L", 136, 921)]),
            (4,  [(2, "R", 136, 807)]),
            (5,  [(3, "L", 136, 862)]),
            (6,  [(3, "R", 136, 728)]),
            (7,  [(4, "F", 136, 898)]),
            (8,  [(5, "F", 136, 605)]),
            (9,  [(5, "F", 605, 1052)]),
            (10, [(6, "F", 136, 917)]),
            (11, [(7, "L", 136, 670)]),
            (12, [(7, "R", 136, 1005)]),
        ],
    },
    "2024A": {"title": "2024학년도 전공A", "pdf": "2024미술A.pdf"},
    "2024B": {"title": "2024학년도 전공B", "pdf": "2024미술B.pdf"},
    "2023A": {"title": "2023학년도 전공A", "pdf": "2023_1차_미술_전공A.pdf"},
    "2023B": {"title": "2023학년도 전공B", "pdf": "2023_1차_미술_전공B.pdf"},
    "2022A": {"title": "2022학년도 전공A", "pdf": "2022_1차_미술_전공A.pdf"},
    "2022B": {"title": "2022학년도 전공B", "pdf": "2022_1차_미술_전공B.pdf"},
    "2021A": {"title": "2021학년도 전공A", "pdf": "2021_1차_미술_전공A.pdf"},
    "2021B": {"title": "2021학년도 전공B", "pdf": "2021_B.pdf"},
    "2020A": {"title": "2020학년도 전공A", "pdf": "2020_A.pdf"},
    "2020B": {"title": "2020학년도 전공B", "pdf": "2020jung14_3.pdf", "points": {4: 4}},   # 배점 글자가 추출되지 않음
    "2019A": {"title": "2019학년도 전공A", "pdf": "2019미술A.pdf"},
    "2019B": {"title": "2019학년도 전공B", "pdf": "2019jung14_3.pdf"},
    "2018A": {"title": "2018학년도 전공A", "pdf": "2018jung14_2.pdf"},
    "2018B": {"title": "2018학년도 전공B", "pdf": "2018_B.pdf"},
    "2017A": {"title": "2017학년도 전공A", "pdf": "2017_중등1차_미술_전공A.pdf"},
    "2017B": {"title": "2017학년도 전공B", "pdf": "2017_중등1차_미술_전공B.pdf"},
    "2016A": {"title": "2016학년도 전공A", "pdf": "2016중등1차-미술-전공A.pdf"},
    "2016B": {"title": "2016학년도 전공B", "pdf": "2016중등1차-미술-전공B.pdf"},
    "2025B": {
        "title": "2025학년도 전공B",
        "pdf": "2025 미술B.pdf",
        "text": False,
        "questions": [
            (1,  [(1, "L", 334, 1032)]),
            (2,  [(1, "R", 277, 642)]),
            (3,  [(2, "L", 136, 555)]),
            (4,  [(2, "R", 136, 887)]),
            (5,  [(3, "F", 136, 830)]),
            (6,  [(4, "F", 136, 842)]),
            (7,  [(5, "L", 136, 759)]),
            (8,  [(5, "R", 136, 627)]),
            (9,  [(6, "F", 136, 937)]),
            (10, [(7, "L", 136, 859)]),
            (11, [(7, "R", 136, 651)]),
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
        m = re.search(r"\[(\d+)\S\]", txt)   # 글꼴이 깨진 PDF 는 '점' 이 다른 글자로 나온다
        if m: return int(m.group(1))
    return None

def render(doc, segs):
    from PIL import Image
    tiles = []
    for (pg, col, y0, y1) in segs:
        x0, x1 = COLS[col]
        y1 = min(y1 + 8, 1088)   # 표 테두리가 잘리지 않도록 아래 여유. 1088 아래는 꼬리말
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
        questions = spec.get("questions") or sorted(auto_segments(doc).items())
        for n, segs in questions:
            img = render(doc, segs)
            rel = f"exam/{eid}/q{n:02d}.jpg"
            img.save(os.path.join(ROOT, rel), "JPEG", quality=88, optimize=True)
            pg, col, y0, _ = segs[0]
            text = first_line(doc[pg - 1], col, y0)[:80] if spec.get("text", True) else ""
            pts = spec.get("points", {}).get(n) or points_of(doc[pg - 1], segs)
            qs.append({"n": n, "points": pts, "text": text, "img": rel})
            print(f"{eid} q{n:02d}: {img.width}x{img.height}  [{qs[-1]['points']}점] {qs[-1]['text'][:40]}")
        entry = {"id": eid, "title": spec["title"], "count": len(qs), "questions": qs}
        index = [e for e in index if e["id"] != eid] + [entry]
    index.sort(key=lambda e: e["id"], reverse=True)
    io.open(idx_path, "w", encoding="utf-8", newline="\n").write(json.dumps(index, ensure_ascii=False, indent=1))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or list(EXAMS)))
