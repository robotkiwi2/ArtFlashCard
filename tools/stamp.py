# -*- coding: utf-8 -*-
"""index.html 이 부르는 app.js / style.css 에 내용 해시를 붙인다.

    <script src="app.js?v=3f9a1c2b">

파일 내용이 바뀌면 주소가 바뀌어 브라우저가 반드시 새로 받고,
안 바뀐 파일은 주소도 그대로라 캐시를 그대로 쓴다.
GitHub Pages 는 모든 파일에 max-age=600 을 붙여 이 장치가 없으면
갱신 뒤에도 옛 app.js 가 10분 넘게 남는다.

커밋 직전에 .git/hooks/pre-commit 이 이 스크립트를 부른다.
손으로 돌려도 된다:  python tools/stamp.py
"""
import hashlib, io, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = ["app.js", "style.css", "firebase.js"]

def digest(path):
    # 작업 사본은 CRLF, 커밋본은 LF 일 수 있다(autocrlf). LF 로 맞춰 해시해야
    # 기기와 무관하게 같은 값이 나오고, GitHub 이 실제로 내보내는 파일과도 일치한다.
    with open(path, "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    return hashlib.sha1(data).hexdigest()[:8]

def app_version():
    # VERSION 파일의 major.minor + 커밋 수(이번 커밋 포함) = v2.0.62 처럼 사람이 읽는 버전
    base = io.open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip() or "0.0"
    try:
        n = int(subprocess.check_output(["git", "rev-list", "--count", "HEAD"], cwd=ROOT).decode().strip()) + 1
    except Exception:
        n = 0
    return f"v{base}.{n}"

def main():
    idx = os.path.join(ROOT, "index.html")
    html = io.open(idx, encoding="utf-8").read()
    before = html
    html = re.sub(r'(<meta name="app-version" content=")[^"]*(")', r'\g<1>%s\g<2>' % app_version(), html)
    for name in TARGETS:
        h = digest(os.path.join(ROOT, name))
        # href="style.css" / href="style.css?v=xxxx" / src="app.js..." 를 모두 잡는다
        html = re.sub(r'((?:href|src)=")%s(?:\?v=[0-9a-f]+)?(")' % re.escape(name),
                      r'\g<1>%s?v=%s\g<2>' % (name, h), html)
    if html != before:
        io.open(idx, "w", encoding="utf-8", newline="\n").write(html)
        print("stamp: index.html updated")
    else:
        print("stamp: no change")
    # 서비스 워커도 같은 버전으로 — 파일 내용이 바뀌어야 브라우저가 새 워커를 설치한다
    swp = os.path.join(ROOT, "sw.js")
    if os.path.exists(swp):
        sw = io.open(swp, encoding="utf-8").read()
        sw2 = re.sub(r'const VERSION = "[^"]*";', 'const VERSION = "%s";' % app_version(), sw)
        if sw2 != sw:
            io.open(swp, "w", encoding="utf-8", newline="\n").write(sw2); print("stamp: sw.js updated")
    return 0

if __name__ == "__main__":
    sys.exit(main())
