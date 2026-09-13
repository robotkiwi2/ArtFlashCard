// Firebase 연결 (인증 + Firestore). app.js 보다 먼저 실행되어 window.FB 를 채운다.
// firebaseConfig 는 공개되어도 되는 값이다 — 실제 접근 통제는 Firestore 규칙(firestore.rules)과 Auth 가 맡는다.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
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
  "auth/too-many-requests": "시도가 너무 많습니다. 잠시 후 다시 해 주세요.",
  "auth/network-request-failed": "네트워크에 연결할 수 없습니다.",
};
function authMessage(err) {
  return AUTH_ERRORS[err && err.code] || `로그인 실패 (${err && err.code || err})`;
}

// ----- 카드 데이터 번들 -----
// bundle/{name}          : { v: 내용 해시, n: 조각 수 }
// bundle/{name}_{i}      : { t: CSV 텍스트 조각 }
// 조각을 이어 붙이면 원본 CSV 와 같다. 해시가 같으면 로컬 캐시를 쓴다.
const BUNDLE_CACHE = "flashcard-bundle-v1:";

async function loadBundle(name) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(BUNDLE_CACHE + name)); } catch {}
  const hasCache = cached && typeof cached.text === "string";
  // 오프라인이거나 메타를 못 읽으면(연결 불량) 캐시로 바로 시작한다. 갱신 확인은 나중에 화면 복귀 때 다시 한다.
  if (hasCache && typeof navigator !== "undefined" && navigator.onLine === false) return cached.text;
  let metaSnap;
  try { metaSnap = await getDoc(doc(db, "bundle", name)); }
  catch (e) { if (hasCache) { console.warn(`[bundle] ${name} 메타 읽기 실패 — 캐시 사용`, e); return cached.text; } throw e; }
  if (!metaSnap.exists()) throw new Error(`bundle/${name} 이 없습니다. tools/upload_firestore.py 를 먼저 실행하세요.`);
  const { v, n, label } = metaSnap.data();
  if (cached && cached.v === v && typeof cached.text === "string") {
    if (label && cached.label !== label) { cached.label = label; try { localStorage.setItem(BUNDLE_CACHE + name, JSON.stringify(cached)); } catch {} }
    return cached.text;
  }

  const parts = await Promise.all(
    Array.from({ length: n }, (_, i) => getDoc(doc(db, "bundle", `${name}_${i}`)))
  );
  const text = parts.map(p => (p.exists() ? p.data().t : "")).join("");
  try { localStorage.setItem(BUNDLE_CACHE + name, JSON.stringify({ v, label: label || "", text })); } catch {}
  return text;
}

// 번들 메타(해시)만 읽는다 — 새 카드 데이터가 올라왔는지 확인하는 용도 (읽기 1회)
async function bundleVersion(name) {
  const snap = await getDoc(doc(db, "bundle", name));
  return snap.exists() ? snap.data().v : null;
}
function cachedBundleVersion(name) {
  try { return (JSON.parse(localStorage.getItem(BUNDLE_CACHE + name)) || {}).v || null; } catch { return null; }
}
function cachedBundleLabel(name) {
  try { return (JSON.parse(localStorage.getItem(BUNDLE_CACHE + name)) || {}).label || null; } catch { return null; }
}

// ----- 학습 기록 -----
// progress/{uid} : { cards: { [cardId]: {tries, correct, box, wrong, last} }, updatedAt }
function progressRef(uid) { return doc(db, "progress", uid); }

async function loadProgress(uid) {
  const snap = await getDoc(progressRef(uid));
  return snap.exists() ? (snap.data().cards || {}) : null;   // null = 클라우드에 아직 문서가 없음
}
async function writeProgress(uid, cards) {
  await setDoc(progressRef(uid), { cards, updatedAt: new Date().toISOString() });
}
// 지정한 카드 항목만 갱신한다 — 다른 기기가 방금 쓴 다른 카드 항목을 덮어쓰지 않는다.
async function saveProgressEntries(uid, entries) {
  const patch = { updatedAt: new Date().toISOString() };
  Object.keys(entries).forEach(id => { patch[`cards.${id}`] = entries[id]; });
  try { await updateDoc(progressRef(uid), patch); }
  catch (e) {
    if (e && e.code === "not-found") await setDoc(progressRef(uid), { cards: entries, updatedAt: patch.updatedAt });
    else throw e;
  }
}
const saveProgressEntry = (uid, cardId, entry) => saveProgressEntries(uid, { [cardId]: entry });

// ----- 카드 신고 -----
// reports/{auto} : { cardId, 표제어, mode, note, uid, email, at, status:"open" }
// 사용자는 만들기만 하고 읽지 않는다(규칙). 검토는 tools/reports.py 가 관리자 SDK 로 한다.
async function addReport(data) {
  const u = auth.currentUser;
  if (!u) throw new Error("로그인이 필요합니다");
  await addDoc(collection(db, "reports"), { ...data, uid: u.uid, email: u.email || "", at: new Date().toISOString(), status: "open" });
}

window.FB = {
  addReport,
  onAuth: cb => onAuthStateChanged(auth, cb),
  login: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
  logout: () => signOut(auth),
  resetPassword: email => sendPasswordResetEmail(auth, email),
  authMessage,
  loadBundle,
  bundleVersion,
  cachedBundleVersion,
  cachedBundleLabel,
  loadProgress,
  writeProgress,
  saveProgressEntry,
  saveProgressEntries,
};
