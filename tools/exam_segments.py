# -*- coding: utf-8 -*-
"""기출 PDF(2단 조판, 842x1191)에서 문항별 영역을 자동으로 잡는다.

각 문항 머리("N. ...")의 위치와 단(L/R/전면 F)을 읽어,
같은 단(또는 전면)에서 다음 머리가 나오기 전까지를 그 문항의 영역으로 본다.
머리 없이 시작하는 단·페이지 내용은 직전 문항의 이어짐으로 붙인다.
"""
import re
import pymupdf

TOP = 137            # 머리글(면수 표시) 아래
BOTTOM = 1088        # 꼬리말 위
COLS = {"L": (78, 420), "R": (422, 768), "F": (78, 768)}
SKIP = ("[전공", "◦문제지", "◦모든 문항", "수고하셨습니다", "문제지 전체 면수", "모든 문항에는 배점")
HEAD = re.compile(r"^(\d{1,2})\.\s")

def col_of(x0, x1):
    if x0 < 415 and x1 > 430: return "F"
    return "L" if x0 < 421 else "R"

def page_items(page):
    """(y0, y1, col, text) — 본문 텍스트 블록과 이미지. 머리글·꼬리말은 뺀다."""
    items = []
    for b in page.get_text("blocks"):
        if b[6] != 0: continue
        t = " ".join(b[4].split())
        if b[3] > BOTTOM or b[1] < TOP - 60 and any(k in t for k in SKIP): continue
        if any(k in t for k in SKIP): continue
        items.append((b[1], b[3], col_of(b[0], b[2]), t, b[0]))
    for im in page.get_image_info():
        x0, y0, x1, y1 = im["bbox"]
        if y1 > BOTTOM or y0 < TOP - 10 or x1 - x0 < 40: continue
        items.append((y0, y1, col_of(x0, x1), "[IMG]", x0))
    return items

def page_heads(items):
    heads = []
    for y0, y1, col, t, x0 in items:
        m = HEAD.match(t)
        if m and (x0 < 100 or 425 < x0 < 445):
            heads.append((y0, col, int(m.group(1))))
    return sorted(heads)

def auto_segments(doc, start_page=1):
    """{문항번호: [(page, col, y0, y1), ...]} (읽는 순서대로)."""
    segs = {}
    order = []          # 문항 번호 등장 순서
    last = None         # 직전 문항 번호 (이어짐 붙일 대상)
    for pno in range(start_page, len(doc) + 1):
        page = doc[pno - 1]
        items = page_items(page)
        heads = page_heads(items)
        if pno == 1 and heads:
            top_head = min(h[0] for h in heads)
            items = [it for it in items if it[0] >= top_head - 2 or HEAD.match(it[3])]   # 1면 표제 영역 제외
        if not heads:
            if last is not None and items:
                y1 = min(max(it[1] for it in items) + 8, BOTTOM)
                segs[last].append((pno, "F", TOP, y1))
            continue
        first_y = {c: min([h[0] for h in heads if h[1] in (c, "F")] or [None]) for c in "LR"}
        # 전면 문항의 아래쪽은 양 단 내용까지 포함해서 잡는다 (전면 머리 아래 2단으로 흐르는 본문)
        col_bottom = lambda c: min(max([it[1] for it in items if c == "F" or it[2] in (c, "F")] or [TOP]) + 8, BOTTOM)

        def pre_content(c):
            pre = [it for it in items if it[2] == c and (first_y[c] is None or it[0] < first_y[c] - 2)]
            if not pre: return None
            return (pno, c, TOP, (first_y[c] - 14) if first_y[c] else col_bottom(c))

        # 1) 왼쪽 단이 머리 없이 시작하면 → 앞 페이지 마지막 문항의 이어짐
        pre_l = pre_content("L")
        if pre_l and last is not None:
            segs[last].append(pre_l)

        # 머리글이 짧아 한 단으로 보여도 본문이 양단에 걸치면 전면 문항이다
        promoted = []
        for (y, col, n) in heads:
            if col != "F":
                nxt = [h[0] for h in heads if h[0] > y]
                end = min(nxt) if nxt else BOTTOM
                # 양 단의 "[별첨 컬러 도판 참고]" 가 한 블록으로 합쳐진 것은 증거로 삼지 않는다
                if any(it[2] == "F" and y < it[0] < end and it[1] - it[0] >= 12 and "별첨" not in it[3] for it in items):
                    col = "F"
            promoted.append((y, col, n))
        heads = promoted
        first_y = {c: min([h[0] for h in heads if h[1] in (c, "F")] or [None]) for c in "LR"}

        # 2) 각 머리의 영역: 같은 단(또는 전면)에서 다음 머리 직전까지
        for i, (y, col, n) in enumerate(heads):
            if n not in segs:
                segs[n] = []; order.append(n)
            later = [h for h in heads if h[0] > y and (col == "F" or h[1] in (col, "F"))]
            end = (min(h[0] for h in later) - 14) if later else col_bottom(col)
            segs[n].append((pno, col, y - 6, end))

        # 3) 오른쪽 단이 머리 없이 시작하면 → 읽는 순서상 바로 앞 문항(이 페이지 왼쪽 단의 마지막 문항,
        #    왼쪽 단에 머리가 없으면 앞 페이지 마지막 문항)의 이어짐
        pre_r = pre_content("R")
        if pre_r:
            ls = [h for h in heads if h[1] in ("L", "F") and h[0] < (first_y["R"] or BOTTOM)]
            owner = ls[-1][2] if ls else last
            if owner is not None: segs[owner].append(pre_r)
        # 읽는 순서상 마지막 문항: L 단 마지막 머리가 R 첫 머리보다 뒤에 읽히지 않도록,
        # 페이지의 마지막 문항은 R 머리가 있으면 R 의 마지막, 없으면 L/F 의 마지막
        rs = [h for h in heads if h[1] == "R"]
        last = (rs[-1] if rs else heads[-1])[2]
    return {n: segs[n] for n in sorted(order)}
