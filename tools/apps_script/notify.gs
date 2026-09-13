/**
 * 가입 요청 알림 + 메일 링크로 승인/보류/거절 처리 (Google Apps Script 웹 앱)
 *
 * 설정 (스크립트 속성: 프로젝트 설정 → 스크립트 속성):
 *   ADMIN_EMAIL          알림 받을 주소 (rei@readerseye.com)
 *   SIGNUP_TOKEN         앱(firebase.js NOTIFY_TOKEN)과 맞출 임의의 문자열
 *   LINK_SECRET          링크 서명용 임의의 긴 문자열 (앱에 넣지 않음)
 *   SERVICE_ACCOUNT_JSON Firebase 서비스 계정 키 json 파일 내용 전체
 *   PROJECT_ID           art-flash-card
 * 배포: 배포 → 새 배포 → 웹 앱 / 실행 사용자: 나 / 액세스: 모든 사용자 → URL 을 firebase.js NOTIFY_URL 에.
 */
const P = PropertiesService.getScriptProperties();
const MAJOR_NAMES = { art: "미술", pe: "체육", korean: "국어" };

// 앱에서 가입 직후 POST { token, uid, email, major, requestedAt }
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || "{}"); } catch (err) {}
  if (!body.token || body.token !== P.getProperty("SIGNUP_TOKEN")) return text("bad token");
  const uid = String(body.uid || ""), email = String(body.email || ""), major = String(body.major || "");
  if (!uid || !email) return text("missing");
  const url = ScriptApp.getService().getUrl();
  const link = action => `${url}?action=${action}&uid=${encodeURIComponent(uid)}&major=${encodeURIComponent(major)}&sig=${sign(action, uid, major)}`;
  const majorName = MAJOR_NAMES[major] || major || "(미지정)";
  const html = `
    <div style="font-family:sans-serif;line-height:1.6">
      <h2 style="margin:0 0 8px">중등 임용 플래시카드 가입 요청</h2>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#666">이메일</td><td><b>${esc(email)}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">희망 전공</td><td><b>${esc(majorName)}</b> (${esc(major)})</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">요청 시각</td><td>${esc(body.requestedAt || "")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">UID</td><td style="font-family:monospace;font-size:12px">${esc(uid)}</td></tr>
      </table>
      <p style="margin:20px 0">
        <a href="${link("approve")}" style="background:#1e8e4e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-right:8px">승인 (${esc(majorName)})</a>
        <a href="${link("hold")}" style="background:#d9932c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-right:8px">보류</a>
        <a href="${link("reject")}" style="background:#c0392b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">거절</a>
      </p>
      <p style="color:#888;font-size:12px">링크는 이 메일을 받은 사람만 유효하게 서명되어 있습니다. 다른 전공으로 승인하려면 grant_major.py 를 쓰세요.</p>
    </div>`;
  MailApp.sendEmail({ to: P.getProperty("ADMIN_EMAIL"), subject: `[임용 플래시카드] 가입 요청: ${email} (${majorName})`, htmlBody: html });
  return text("ok");
}

// 메일의 링크 클릭 (GET)
function doGet(e) {
  const q = e.parameter || {};
  const action = q.action, uid = q.uid || "", major = q.major || "";
  if (!["approve", "hold", "reject"].includes(action) || !uid) return page("잘못된 요청입니다.");
  if (q.sig !== sign(action, uid, major)) return page("서명이 맞지 않습니다. 메일의 링크를 그대로 눌러 주세요.");
  const fields = { status: { stringValue: action === "approve" ? "approved" : action === "hold" ? "hold" : "rejected" },
                   decidedAt: { stringValue: new Date().toISOString() } };
  if (action === "approve") fields.majors = { arrayValue: { values: major ? [{ stringValue: major }] : [] } };
  const mask = Object.keys(fields).map(k => "updateMask.fieldPaths=" + k).join("&");
  const res = UrlFetchApp.fetch(
    `https://firestore.googleapis.com/v1/projects/${P.getProperty("PROJECT_ID")}/databases/(default)/documents/users/${encodeURIComponent(uid)}?${mask}`,
    { method: "patch", contentType: "application/json", payload: JSON.stringify({ fields }),
      headers: { Authorization: "Bearer " + accessToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) return page("Firestore 갱신 실패: " + res.getContentText());
  const label = { approve: `승인 완료 — 전공 '${MAJOR_NAMES[major] || major}' 부여`, hold: "보류 처리됨", reject: "거절 처리됨" }[action];
  return page(label + `<br><small style="color:#888">${esc(uid)}</small>`);
}

// ----- 서명 / 서비스 계정 토큰 -----
function sign(action, uid, major) {
  const raw = Utilities.computeHmacSha256Signature(`${action}|${uid}|${major}`, P.getProperty("LINK_SECRET"));
  return raw.map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}
function accessToken() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("sa_token"); if (hit) return hit;
  const sa = JSON.parse(P.getProperty("SERVICE_ACCOUNT_JSON"));
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, "");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, "");
  const r = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", { method: "post",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig } });
  const token = JSON.parse(r.getContentText()).access_token;
  cache.put("sa_token", token, 3000);
  return token;
}

// ----- 유틸 -----
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function text(s) { return ContentService.createTextOutput(s); }
function page(msg) {
  return HtmlService.createHtmlOutput(`<div style="font-family:sans-serif;padding:32px;font-size:18px;line-height:1.6">${msg}</div>`);
}
