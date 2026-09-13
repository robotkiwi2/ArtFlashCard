# -*- coding: utf-8 -*-
"""기출문제 PDF 에서 문항별 이미지를 잘라 exam/<전공>/<시험id>/qNN.jpg 와 exam/<전공>/index.json 을 만든다.

    python tools/extract_exam.py <전공id> [시험id ...]
    예) python tools/extract_exam.py art            subjects/art/exams.json 의 모든 시험지
        python tools/extract_exam.py pe 2026A 2026B

subjects/<전공>/exams.json 형식:
{
 "pdfDir": "체육전공/기출문제",          # 저장소 상위 폴더 기준 PDF 폴더
 "exams": {
   "2026A": {"title": "2026학년도 전공A", "pdf": "2026_체육_2a.pdf"},
   "2025A": {"title": "...", "pdf": "...", "text": false,          # 글꼴이 깨진 PDF 는 텍스트를 쓰지 않음
             "points": {"4": 4},                                   # 배점 추출 실패 시 수동 지정
             "questions": [[1, [[1, "L", 335, 900]]], ...]}        # 자동 분할이 어긋날 때 (page, col, y0, y1) 수동 지정
 }
}
문항 영역은 exam_segments.auto_segments 가 문항 머리("N. ") 위치로 자동으로 잡는다 (평가원 2단 조판 842x1191 기준).
"""
import io, json, os, re, sys
import pymupdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exam_segments import auto_segments, COLS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZOOM = 2.0

def first_line(page, col, y0):
    x0, x1 = COLS[col]
    txt = page.get_text("text", clip=pymupdf.Rect(x0, y0, x1, y0 + 40))
    line = " ".join(txt.split())
    m = re.match(r"^(\d{1,2})\.\s*(.*)$", line)
    return (m.group(2) if m else line)

def points_of(doc, segs):
    for (pg, col, y0, y1) in segs:
        x0, x1 = COLS[col]
        txt = doc[pg - 1].get_text("text", clip=pymupdf.Rect(x0, y0, x1, y1))
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

def main(argv):
    if not argv:
        print(__doc__); return 1
    major, ids = argv[0], argv[1:]
    spec_path = os.path.join(ROOT, "subjects", major, "exams.json")
    spec_all = json.load(io.open(spec_path, encoding="utf-8"))
    pdf_dir = os.path.join(os.path.dirname(ROOT), spec_all["pdfDir"])
    exams = spec_all["exams"]
    out_dir = os.path.join(ROOT, "exam", major)
    os.makedirs(out_dir, exist_ok=True)
    idx_path = os.path.join(out_dir, "index.json")
    index = json.load(io.open(idx_path, encoding="utf-8")) if os.path.exists(idx_path) else []
    for eid in (ids or list(exams)):
        spec = exams[eid]
        doc = pymupdf.open(os.path.join(pdf_dir, spec["pdf"]))
        os.makedirs(os.path.join(out_dir, eid), exist_ok=True)
        if spec.get("questions"):
            questions = [(n, [tuple(s) for s in segs]) for n, segs in spec["questions"]]
        else:
            questions = sorted(auto_segments(doc).items())
        qs = []
        for n, segs in questions:
            img = render(doc, segs)
            rel = f"exam/{major}/{eid}/q{n:02d}.jpg"
            img.save(os.path.join(ROOT, rel), "JPEG", quality=88, optimize=True)
            pg, col, y0, _ = segs[0]
            text = first_line(doc[pg - 1], col, y0)[:80] if spec.get("text", True) else ""
            pts = (spec.get("points") or {}).get(str(n)) or points_of(doc, segs)
            qs.append({"n": n, "points": pts, "text": text, "img": rel})
            print(f"{eid} q{n:02d}: {img.width}x{img.height}  [{pts}점] {text[:40]}")
        entry = {"id": eid, "title": spec["title"], "count": len(qs), "questions": qs}
        index = [e for e in index if e["id"] != eid] + [entry]
        print(f"{eid}: {len(qs)}문항, 배점 합 {sum(q['points'] or 0 for q in qs)}")
    index.sort(key=lambda e: e["id"], reverse=True)
    io.open(idx_path, "w", encoding="utf-8", newline="\n").write(json.dumps(index, ensure_ascii=False, indent=1))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
