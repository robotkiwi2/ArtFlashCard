# -*- coding: utf-8 -*-
"""subjects/<패키지>/ 의 cards.csv, links.csv, config.json 을 Firestore bundle/<패키지>/files 에 올린다.

    python tools/upload_firestore.py            모든 패키지
    python tools/upload_firestore.py art        하나만

카드를 고친 뒤 이 스크립트를 한 번 돌리면 앱이 다음 실행 때 새 데이터를 받는다.
(내용 해시가 바뀌면 앱의 로컬 캐시가 무효화된다.)

서비스 계정 키가 필요하다:
  Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
  받은 json 을 저장소 밖(기본: 상위 폴더)에 firebase-admin-key.json 으로 두거나
  환경변수 FIREBASE_KEY 로 경로를 준다. 이 키는 절대 커밋하지 않는다.

    pip install firebase-admin
"""
import datetime, hashlib, io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("FIREBASE_KEY") or os.path.join(os.path.dirname(ROOT), "firebase-admin-key.json")
SUBJECTS = os.path.join(ROOT, "subjects")
FILES = {"cards": "cards.csv", "links": "links.csv", "config": "config.json"}
CHUNK = 700_000   # Firestore 문서 한도 1 MiB 보다 넉넉히 작게 (UTF-8 바이트 기준)

def chunks(text):
    out, buf, size = [], [], 0
    for line in text.splitlines(keepends=True):
        b = len(line.encode("utf-8"))
        if buf and size + b > CHUNK:
            out.append("".join(buf)); buf, size = [], 0
        buf.append(line); size += b
    if buf: out.append("".join(buf))
    return out

def main(pkgs):
    if not os.path.exists(KEY):
        print(f"서비스 계정 키가 없습니다: {KEY}"); return 1
    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(KEY))
    db = firebase_admin.firestore.client()

    pkgs = pkgs or sorted(d for d in os.listdir(SUBJECTS) if os.path.isdir(os.path.join(SUBJECTS, d)))
    for pkg in pkgs:
        files = db.collection("bundle").document(pkg).collection("files")
        for name, rel in FILES.items():
            path = os.path.join(SUBJECTS, pkg, rel)
            if not os.path.exists(path): continue
            raw = io.open(path, "rb").read().replace(b"\r\n", b"\n")
            text = raw.decode("utf-8-sig")
            v = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
            meta = files.document(name).get()
            if meta.exists and meta.to_dict().get("v") == v:
                print(f"{pkg}/{name}: 변경 없음 ({v})"); continue
            parts = chunks(text)
            batch = db.batch()
            for i, t in enumerate(parts):
                batch.set(files.document(f"{name}_{i}"), {"t": t})
            old_n = meta.to_dict().get("n", 0) if meta.exists else 0
            for i in range(len(parts), old_n):
                batch.delete(files.document(f"{name}_{i}"))
            label = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
            batch.set(files.document(name), {"v": v, "n": len(parts), "label": label})
            batch.commit()
            print(f"{pkg}/{name}: 업로드 {len(parts)}조각, {len(raw):,} bytes ({v})")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
