# -*- coding: utf-8 -*-
"""사용자에게 전공(패키지) 권한을 준다 / 뺀다 / 목록을 본다.

    python tools/grant_major.py                         모든 사용자와 전공 목록
    python tools/grant_major.py user@x.com art          art 부여 (없는 계정이면 안내)
    python tools/grant_major.py user@x.com art --remove art 제거
"""
import os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("FIREBASE_KEY") or os.path.join(os.path.dirname(ROOT), "firebase-admin-key.json")

def main(argv):
    import firebase_admin
    from firebase_admin import credentials, firestore, auth
    firebase_admin.initialize_app(credentials.Certificate(KEY))
    db = firebase_admin.firestore.client()
    if not argv:
        docs = {d.id: d.to_dict() for d in db.collection("users").stream()}
        for u in auth.list_users().iterate_all():
            d = docs.get(u.uid, {})
            print(f"{u.email:32s} majors={d.get('majors', '(문서 없음)')}  {'승인 대기' if d and not d.get('majors') else ''}")
        return 0
    email, major = argv[0], argv[1]
    remove = "--remove" in argv
    u = auth.get_user_by_email(email)
    ref = db.collection("users").document(u.uid)
    cur = ref.get().to_dict() or {}
    majors = [m for m in cur.get("majors", []) if m != major]
    if not remove: majors.append(major)
    ref.set({"email": email, "majors": majors}, merge=True)
    print(f"{email}: majors={majors}")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
