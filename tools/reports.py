# -*- coding: utf-8 -*-
"""카드 신고("이상해요")를 검토한다.

    python tools/reports.py              미처리 신고를 카드별로 묶어 보여 준다
    python tools/reports.py --all        처리된 것까지
    python tools/reports.py --done ID... 해당 신고를 처리 완료로 표시 (카드id 를 주면 그 카드의 미처리 신고 전부)

서비스 계정 키는 tools/upload_firestore.py 와 같은 위치를 쓴다.
"""
import csv, io, os, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("FIREBASE_KEY") or os.path.join(os.path.dirname(ROOT), "firebase-admin-key.json")

def load_cards():
    with io.open(os.path.join(ROOT, "data/cards.csv"), encoding="utf-8-sig", newline="") as f:
        return {r["id"]: r for r in csv.DictReader(f)}

def main(argv):
    import firebase_admin
    from firebase_admin import credentials, firestore
    from google.cloud.firestore_v1 import FieldFilter
    firebase_admin.initialize_app(credentials.Certificate(KEY))
    col = firebase_admin.firestore.client().collection("reports")

    if argv and argv[0] == "--done":
        ids = set(argv[1:])
        n = 0
        for d in col.where(filter=FieldFilter("status", "==", "open")).stream():
            if d.id in ids or d.to_dict().get("cardId") in ids:
                d.reference.update({"status": "done"}); n += 1
        print(f"{n}건 처리 완료"); return 0

    show_all = "--all" in argv
    docs = list(col.stream()) if show_all else list(col.where(filter=FieldFilter("status", "==", "open")).stream())
    if not docs:
        print("신고 없음"); return 0
    cards = load_cards()
    by_card = defaultdict(list)
    for d in docs:
        by_card[d.to_dict().get("cardId", "?")].append((d.id, d.to_dict()))
    for cid, items in sorted(by_card.items(), key=lambda kv: -len(kv[1])):
        c = cards.get(cid, {})
        print(f"\n=== [{cid}] {c.get('표제어', items[0][1].get('표제어', ''))}  ({c.get('과목','')}/{c.get('유형','')})  신고 {len(items)}건")
        if c: print(f"    축1: {c.get('축1','')[:120]}")
        for rid, r in sorted(items, key=lambda x: x[1].get("at", "")):
            mark = "" if r.get("status") == "open" else " (처리됨)"
            why = " / ".join(r.get("reasons") or [])
            note = r.get("note", "")
            body = " · ".join(x for x in [why, note] if x) or "(내용 없음)"
            print(f"  - {r.get('at','')[:16]} {r.get('email','')} [{r.get('mode','')}] {body}  id={rid}{mark}")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
