// Firebase 연결 (인증 + Firestore). app.js 보다 먼저 실행되어 window.FB 를 채운다.
// firebaseConfig 는 공개되어도 되는 값이다 — 실제 접근 통제는 Firestore 규칙(firestore.rules)과 Auth 가 맡는다.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  createUserWithEmailAndPassword, updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAcxCX1EtwKw5KHUotOABSTeLOfOzZ--RE",
  authDomain: "art-flash-card.firebaseapp.com",
  projectId: "art-flash-card",
  storageBucket: "art-flash-card.firebasestorage.app",
  messagingSenderId: "371231285346",
  appId: "1:371231285346:web:890374aa403a2d472bf13b",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const AUTH_ERRORS = {
  "auth/invalid-credential": "이메일 또는 비밀번호가 맞지 않습니다.",
  "auth/wrong-password": "이메일 또는 비밀번호가 맞지 않습니다.",
  "auth/user-not-found": "등록되지 않은 이메일입니다.",
  "auth/invalid-email": "이메일 형식이 올바르지 않습니다.",
  "auth/email-already-in-use": "이미 가입된 이메일입니다.",
  "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
  "auth/requires-recent-login": "보안을 위해 다시 로그인한 뒤 시도해 주세요.",
  "auth/too-many-requests": "시도가 너무 많습니다. 잠시 후 다시 해 주세요.",
  "auth/network-request-failed": "네트워크에 연결할 수 없습니다.",
};
function authMessage(err) {
  return AUTH_ERRORS[err && err.code] || `실패 (${err && err.code || err})`;
}

// ----- 사용자 권한 -----
// users/{uid} : { majors: ["art", ...], email, createdAt }   관리자 스크립트(tools/grant_major.py)만 쓴다.
// 가입 직후에는 문서가 없거나 majors 가 비어 있다 → 앱은 '승인 대기' 화면을 보여 준다.
async function loadUser(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// ----- 카드 데이터 번들 -----
// bundle/{pkg}/files/{name}      : { v: 내용 해시, n: 조각 수, label: 업로드 시각 }
// bundle/{pkg}/files/{name}_{i}  : { t: 텍스트 조각 }
// 조각을 이어 붙이면 원본 파일과 같다. 해시가 같으면 로컬 캐시를 쓴다.
const BUNDLE_CACHE = "flashcard-bundle-v2:";
const fileRef = (pkg, name) => doc(db, "bundle", pkg, "files", name);

async function loadBundle(pkg, name) {
  const key = BUNDLE_CACHE + pkg + ":" + name;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
  const hasCache = cached && typeof cached.text === "string";
  // 오프라인이거나 메타를 못 읽으면(연결 불량) 캐시로 바로 시작한다. 갱신 확인은 나중에 화면 복귀 때 다시 한다.
  if (hasCache && typeof navigator !== "undefined" && navigator.onLine === false) return cached.text;
  let metaSnap;
  try { metaSnap = await getDoc(fileRef(pkg, name)); }
  catch (e) { if (hasCache) { console.warn(`[bundle] ${pkg}/${name} 메타 읽기 실패 — 캐시 사용`, e); return cached.text; } throw e; }
  if (!metaSnap.exists()) throw new Error(`bundle/${pkg}/${name} 이 없습니다. tools/upload_firestore.py ${pkg} 를 먼저 실행하세요.`);
  const { v, n, label } = metaSnap.data();
  if (hasCache && cached.v === v) {
    if (label && cached.label !== label) { cached.label = label; try { localStorage.setItem(key, JSON.stringify(cached)); } catch {} }
    return cached.text;
  }
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(fileRef(pkg, `${name}_${i}`))));
  const text = parts.map(p => (p.exists() ? p.data().t : "")).join("");
  try { localStorage.setItem(key, JSON.stringify({ v, label: label || "", text })); } catch {}
  return text;
}
// 번들 메타(해시)만 읽는다 — 새 데이터가 올라왔는지 확인하는 용도 (읽기 1회)
async function bundleVersion(pkg, name) {
  const snap = await getDoc(fileRef(pkg, name));
  return snap.exists() ? snap.data().v : null;
}
function cachedBundle(pkg, name) {
  try { return JSON.parse(localStorage.getItem(BUNDLE_CACHE + pkg + ":" + name)) || {}; } catch { return {}; }
}

// ----- 학습 기록 -----
// progress/{uid}/pkgs/{pkg} : { cards: { [cardId]: {tries, correct, box, wrong, last} }, updatedAt }
const progressRef = (uid, pkg) => doc(db, "progress", uid, "pkgs", pkg);

async function loadProgress(uid, pkg) {
  const snap = await getDoc(progressRef(uid, pkg));
  return snap.exists() ? (snap.data().cards || {}) : null;   // null = 클라우드에 아직 문서가 없음
}
async function writeProgress(uid, pkg, cards) {
  await setDoc(progressRef(uid, pkg), { cards, updatedAt: new Date().toISOString() });
}
// 지정한 카드 항목만 갱신한다 — 다른 기기가 방금 쓴 다른 카드 항목을 덮어쓰지 않는다.
async function saveProgressEntries(uid, pkg, entries) {
  const patch = { updatedAt: new Date().toISOString() };
  Object.keys(entries).forEach(id => { patch[`cards.${id}`] = entries[id]; });
  try { await updateDoc(progressRef(uid, pkg), patch); }
  catch (e) {
    if (e && e.code === "not-found") await setDoc(progressRef(uid, pkg), { cards: entries, updatedAt: patch.updatedAt });
    else throw e;
  }
}

// ----- 카드 신고 -----
// reports/{auto} : { pkg, cardId, 표제어, mode, reasons, note, uid, email, at, status:"open" }
async function addReport(data) {
  const u = auth.currentUser;
  if (!u) throw new Error("로그인이 필요합니다");
  await addDoc(collection(db, "reports"), { ...data, uid: u.uid, email: u.email || "", at: new Date().toISOString(), status: "open" });
}

// ----- 공개 메타 -----
async function listMajors() {
  try { const s = await getDoc(doc(db, "meta", "majors")); return (s.exists() && s.data().list) || []; }
  catch { return []; }
}

// ----- 계정 -----
// 가입 알림: Google Apps Script 웹훅 (tools/apps_script/notify.gs). 관리자 메일로 승인/보류/거절 링크가 간다.
const NOTIFY_URL = "";          // 배포한 Apps Script 웹 앱 URL
const NOTIFY_TOKEN = "O0SsGrUjqI1RTOYr3f7_hIUY";   // Apps Script 스크립트 속성 SIGNUP_TOKEN 과 같은 값
async function signup(email, pw, major) {
  const cred = await createUserWithEmailAndPassword(auth, email, pw);
  const uid = cred.user.uid, requestedAt = new Date().toISOString();
  // 승인 요청 기록 (규칙: 본인 문서 최초 생성, majors 는 빈 배열만 허용)
  try { await setDoc(doc(db, "users", uid), { email, majors: [], requestedMajor: major || "", status: "pending", requestedAt }); } catch (e) { console.warn(e); }
  if (NOTIFY_URL) {
    try {
      await fetch(NOTIFY_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ token: NOTIFY_TOKEN, uid, email, major: major || "", requestedAt }) });
    } catch (e) { console.warn("[signup] 알림 전송 실패", e); }
  }
  return cred.user;
}
async function changePassword(currentPw, newPw) {
  const u = auth.currentUser;
  const cred = EmailAuthProvider.credential(u.email, currentPw);
  await reauthenticateWithCredential(u, cred);
  await updatePassword(u, newPw);
}

window.FB = {
  onAuth: cb => onAuthStateChanged(auth, cb),
  login: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
  logout: () => signOut(auth),
  resetPassword: email => sendPasswordResetEmail(auth, email),
  signup, changePassword, authMessage, listMajors,
  loadUser,
  loadBundle, bundleVersion, cachedBundle,
  loadProgress, writeProgress, saveProgressEntries,
  addReport,
};
