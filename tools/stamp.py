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
import hashlib, io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = ["app.js", "style.css"]

def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]

def main():
    idx = os.path.join(ROOT, "index.html")
    html = io.open(idx, encoding="utf-8").read()
    before = html
    for name in TARGETS:
        h = digest(os.path.join(ROOT, name))
        # href="style.css" / href="style.css?v=xxxx" / src="app.js..." 를 모두 잡는다
        html = re.sub(r'((?:href|src)=")%s(?:\?v=[0-9a-f]+)?(")' % re.escape(name),
                      r'\g<1>%s?v=%s\g<2>' % (name, h), html)
    if html != before:
        io.open(idx, "w", encoding="utf-8", newline="\n").write(html)
        print("stamp: index.html 갱신")
    else:
        print("stamp: 변경 없음")
    return 0

if __name__ == "__main__":
    sys.exit(main())
