# 가입 알림 웹훅 설정 (Google Apps Script)

가입 요청이 오면 관리자 메일로 [승인]/[보류]/[거절] 링크가 든 메일을 보내고, 링크 클릭으로 Firestore `users/{uid}` 를 갱신한다.
Cloud Functions(유료 플랜) 없이 무료로 동작한다. 한 번만 설정하면 된다.

1. https://script.google.com → 새 프로젝트 → 이름 "임용 플래시카드 가입 알림"
2. 기본 `Code.gs` 내용을 지우고 `notify.gs` 내용을 붙여 넣기 → 저장
3. 왼쪽 톱니(프로젝트 설정) → **스크립트 속성** 에 5개 추가
   - `ADMIN_EMAIL` = rei@readerseye.com
   - `SIGNUP_TOKEN` = firebase.js 의 `NOTIFY_TOKEN` 값 (아래 참고)
   - `LINK_SECRET` = 아무 긴 문자열 (예: 비밀번호 생성기로 32자)
   - `PROJECT_ID` = art-flash-card
   - `SERVICE_ACCOUNT_JSON` = `../firebase-admin-key.json` 파일 내용 전체를 그대로 붙여 넣기 (한 줄이어도 됨)
4. 배포 → **새 배포** → 유형 "웹 앱" → 설명 아무거나 → **실행 사용자: 나** / **액세스 권한: 모든 사용자** → 배포
   - 처음엔 권한 승인 창이 뜬다(Gmail 발송·외부 URL 접근 허용). "고급 → 안전하지 않은 페이지로 이동"을 눌러 진행.
5. 나온 **웹 앱 URL**(`https://script.google.com/macros/s/.../exec`)을 firebase.js 의 `NOTIFY_URL` 에 넣고 커밋·푸시

코드를 수정하면 배포 → 배포 관리 → 연필 → 버전 "새 버전" 으로 다시 배포해야 반영된다.

## 동작
- 앱이 가입 직후 웹 앱에 POST → `doPost` 가 메일 발송
- 메일의 링크(`?action=approve&uid=…&sig=…`) 클릭 → `doGet` 이 서명을 확인하고 서비스 계정으로 Firestore 갱신
  - 승인: `majors: [희망전공]`, `status: approved`
  - 보류: `status: hold`, 거절: `status: rejected` (앱의 대기 화면 문구가 바뀜)
- 다른 전공으로 승인하거나 전공을 더 주려면 `python tools/grant_major.py 이메일 전공`
