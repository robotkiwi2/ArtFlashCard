"use strict";

// ===== 상태 =====
let CARDS = [];                 // 전체 카드
let LINKS = new Map();          // 표제어 → 관계 목록 (data/links.csv)
let selectedSubject = "";       // "" = 전체 과목 (단일 선택)
let filters = { 유형: new Set(), 시대: new Set(), 태그: new Set(), 중요도: new Set() };
let session = null;             // { queue, idx, mode, correct, wrongCards }
// 전공 패키지. 한 번에 전공 하나만 활성화하고, 교육학(common)은 항상 함께 싣는다.
let USER = null;                // users/{uid} 문서 ({ majors: [...] })
let MAJOR = "";                 // 활성 전공 id (예: "art")
let PKGS = [];                  // 함께 싣는 패키지 순서: ["common", MAJOR]
let CONFIG = {};                // { [pkg]: config.json }
const MAJOR_KEY = "flashcard-major-v1";
const APP_TITLE = "중등 임용 플래시카드";
function majorConfig() { return CONFIG[MAJOR] || {}; }
function subjectAbbr(name) {
  for (const pkg of PKGS) { const m = (CONFIG[pkg] || {}).subjectAbbr || {}; if (m[name]) return m[name]; }
  return name;
}

const LS_KEY = "flashcard-stats-v1";
const FS_KEY = "flashcard-fontsize-v1";
const FONT_SIZES = [
  { label: "작게",    scale: 1.0 },
  { label: "보통",    scale: 1.2 },   // 기본값
  { label: "크게",    scale: 1.45 },
  { label: "아주 크게", scale: 1.75 },
];
const FS_DEFAULT = 1.2;
const THEME_KEY = "flashcard-theme-v1";
const THEME_OPTIONS = [
  { value: "light",  label: "라이트" },
  { value: "dark",   label: "다크" },
  { value: "system", label: "시스템 설정 따름" },
];
const THEME_DEFAULT = "system";
const DEP_KEYS = [
  ["유형", "filter-type"],
  ["시대", "filter-era"],
  ["태그", "filter-tag"],
  ["중요도", "filter-imp"],
];
// 값이 비어 있으면 해당 필터를 적용하지 않는 컬럼 (예: 시대 없는 카드)
const OPTIONAL_KEYS = new Set(["시대", "태그"]);

// ===== CSV 파싱 (따옴표 지원) =====
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(f => f !== "")) rows.push(row); }
  return rows;
}

// cacheFirst: 로컬 캐시가 있으면 서버 확인 없이 바로 쓴다 (로그인 직후 빠른 시작). 패키지끼리는 병렬로 받는다.
let CACHE_FIRST = false;
async function loadCards() {
  CARDS = []; CONFIG = {};
  const opt = { cacheFirst: CACHE_FIRST };
  const got = await Promise.all(PKGS.map(async pkg => {
    const [cfg, text] = await Promise.all([
      FB.loadBundle(pkg, "config", opt).then(t => JSON.parse(t)).catch(() => ({})),
      FB.loadBundle(pkg, "cards", opt),    // Firestore 번들 (허용된 전공만). 해시가 같으면 로컬 캐시
    ]);
    return { pkg, cfg, text };
  }));
  got.forEach(({ pkg, cfg, text }) => {
    CONFIG[pkg] = cfg;
    const rows = parseCSV(text);
    const header = rows[0];
    rows.slice(1).forEach(r => {
      const o = { pkg };
      header.forEach((h, i) => o[h.trim()] = (r[i] || "").trim());
      o.태그목록 = o.태그 ? o.태그.split(";").map(t => t.trim()).filter(Boolean) : [];
      CARDS.push(o);
    });
  });
}
function cardPkg(id) { const c = CARDS.find(x => x.id === String(id)); return c ? c.pkg : MAJOR; }

// ===== 관계 (data/links.csv) =====
// 카드에 관계를 심지 않고 별도 테이블로 둔다. 관계 종류가 늘어도 카드 스키마는 그대로다.
// 한 행이 양방향으로 동작한다. 아래 사전이 역방향에서 붙일 이름을 정한다.
const REL_REVERSE = {
  "관련": "관련",      // 대칭
  "대비": "대비",      // 대칭
  "상위": "하위",
  "계보": "선행",
  "영향": "영향받음",
  "작품": "작가",
  "기법": "사용례",
  "주장": "주창자",
  "대표작가": "사조",
  "도구": "쓰임",
  "대표작품": "사조",
};

async function loadLinks() {
  LINKS = new Map();   // 표제어 → [{ rel, other, memo }]
  let rows = [];
  const texts = await Promise.all(PKGS.map(pkg => FB.loadBundle(pkg, "links", { cacheFirst: CACHE_FIRST }).catch(() => "")));
  texts.forEach(t => { if (t) rows = rows.concat(parseCSV(t).slice(1)); });
  rows = [[]].concat(rows);   // 아래 코드가 첫 행을 머리글로 건너뛴다
  const names = new Set(CARDS.map(c => c.표제어));
  const missing = [];
  const push = (key, rel, other, memo) => {
    if (!LINKS.has(key)) LINKS.set(key, []);
    LINKS.get(key).push({ rel, other, memo });
  };

  rows.slice(1).forEach(r => {
    const [from, rel, to, memo] = [0, 1, 2, 3].map(i => (r[i] || "").trim());
    if (!from || !rel || !to) return;
    // 참조 무결성: 카드가 없는 표제어는 버리고 경고만 남긴다
    if (!names.has(from)) { missing.push(from); return; }
    if (!names.has(to)) { missing.push(to); return; }
    push(from, rel, to, memo);
    push(to, REL_REVERSE[rel] || rel, from, memo);
  });
  if (missing.length) {
    console.warn("[links] 카드에 없는 표제어 참조:", [...new Set(missing)]);
  }
}

// ===== 학습 기록 =====
// 원본은 Firestore progress/{uid}. 로컬(localStorage)은 사용자별 캐시라서 동기 호출이 가능하고,
// 오프라인이어도 화면이 뜬다. 채점할 때마다 그 카드 항목만 클라우드에 올리고,
// 로그인·재접속 때 로컬과 클라우드를 카드별 최신 시각(last) 기준으로 합친다.
let currentUser = null;
// 패키지별로 나눠 저장한다(progress/{uid}/pkgs/{pkg}). 전공을 바꿔도 다른 전공·교육학 기록이 그대로 남는다.
function statsKey(pkg) { return `${LS_KEY}:${currentUser ? currentUser.uid : "anon"}:${pkg}`; }
function loadPkgStats(pkg) {
  try { return JSON.parse(localStorage.getItem(statsKey(pkg))) || {}; } catch { return {}; }
}
function storePkgStats(pkg, stats) {
  try { localStorage.setItem(statsKey(pkg), JSON.stringify(stats)); } catch {}
}
function loadStats() {   // 활성 패키지들의 기록을 하나로 합쳐 돌려준다 (카드 id 는 패키지 간에 겹치지 않음)
  const out = {};
  PKGS.forEach(pkg => Object.assign(out, loadPkgStats(pkg)));
  return out;
}
function storeStats(stats) {   // 합쳐진 기록을 카드의 패키지대로 나눠 저장
  const by = {}; PKGS.forEach(p => by[p] = {});
  Object.keys(stats).forEach(id => { const p = cardPkg(id); (by[p] || (by[p] = {}))[id] = stats[id]; });
  Object.keys(by).forEach(p => storePkgStats(p, by[p]));
}
function newer(a, b) {   // last 가 더 최근인 쪽. 없으면 있는 쪽, 둘 다 없으면 시도 수가 많은 쪽
  if (!a) return b; if (!b) return a;
  if (a.last && b.last) return a.last >= b.last ? a : b;
  if (a.last || b.last) return a.last ? a : b;
  return (a.tries || 0) >= (b.tries || 0) ? a : b;
}
function mergeStats(local, remote) {
  const out = {};
  new Set([...Object.keys(local), ...Object.keys(remote)]).forEach(id => { out[id] = newer(local[id], remote[id]); });
  return out;
}

// 로그인 직후, 그리고 앱이 다시 화면에 나타날 때·세션을 시작할 때 다시 부른다.
// 다른 기기에서 그사이 푼 기록을 받아 오기 위해서다. 예전(로그인 이전) 기록이 기기에 남아 있으면 함께 합친다.
let lastSyncAt = 0, syncing = null;
const SYNC_MIN_GAP = 30 * 1000;   // 너무 잦은 읽기를 막는 최소 간격
function syncProgress() {
  if (syncing) return syncing;
  syncing = doSyncProgress().finally(() => { syncing = null; lastSyncAt = Date.now(); });
  return syncing;
}
async function resyncIfStale() {
  if (!currentUser || Date.now() - lastSyncAt < SYNC_MIN_GAP) return;
  await syncProgress();
}
// 예전(전공 분리 이전) 로컬 기록: flashcard-stats-v1[:uid] 한 덩어리. 교육학 카드는 id 앞에 c 가 붙었다.
function takeLegacyStats() {
  const keys = [LS_KEY, currentUser ? `${LS_KEY}:${currentUser.uid}` : null].filter(Boolean);
  const out = {}; let found = false;
  keys.forEach(k => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v && Object.keys(v).length) { found = true; Object.keys(v).forEach(id => {
        const nid = CARDS.some(c => c.id === id) ? id : (CARDS.some(c => c.id === "c" + id) ? "c" + id : null);
        if (nid) out[nid] = v[id];
      }); }
    } catch {}
  });
  return found ? { stats: out, keys } : null;
}
async function doSyncProgress() {
  const legacy = takeLegacyStats();
  await Promise.all(PKGS.map(async pkg => {
    let local = loadPkgStats(pkg);
    if (legacy) {
      const part = {}; Object.keys(legacy.stats).forEach(id => { if (cardPkg(id) === pkg) part[id] = legacy.stats[id]; });
      local = mergeStats(local, part);
    }
    let remote = null;
    try { remote = await FB.loadProgress(currentUser.uid, pkg); }
    catch (e) { console.warn(`[sync] ${pkg} 클라우드 기록을 읽지 못함 — 로컬 기록으로 진행`, e); storePkgStats(pkg, local); return; }
    const merged = mergeStats(local, remote || {});
    storePkgStats(pkg, merged);
    try {
      if (!remote) await FB.writeProgress(currentUser.uid, pkg, merged);
      else {
        // 로컬이 이긴 카드만 올린다. 문서 전체를 덮어쓰면 읽고 쓰는 사이 다른 기기가 쓴 항목이 사라질 수 있다.
        const won = {};
        Object.keys(merged).forEach(id => { if (merged[id] !== remote[id]) won[id] = merged[id]; });
        if (Object.keys(won).length) await FB.saveProgressEntries(currentUser.uid, pkg, won);
      }
    } catch (e) { console.warn(`[sync] ${pkg} 클라우드 기록 저장 실패`, e); }
  }));
  if (legacy) legacy.keys.forEach(k => { try { localStorage.removeItem(k); } catch {} });
}

// box = 연속 정답 횟수(0~5). 맞히면 오르고 틀리면 0으로 초기화된다.
// wrong = 오답 노트 수록 여부. 틀리면 true·맞히면 false.
// hintUsed = 힌트(글자 수·초성)를 보고 맞힌 경우. 완전한 인출이 아니므로 box를 올리지 않아
// 복습 주기를 짧게 유지한다(오답으로 되돌리지는 않는다).
function saveResult(cardId, isCorrect, hintUsed) {
  const s = loadPkgStats(cardPkg(cardId))[cardId] || { tries: 0, correct: 0, box: 0 };
  s.tries++;
  if (isCorrect) {
    s.correct++;
    if (!hintUsed) s.box = Math.min((s.box || 0) + 1, 5);
    s.wrong = false;
  } else {
    s.box = 0;
    s.wrong = true;
  }
  s.last = new Date().toISOString();   // 같은 날 안에서도 순서를 가리려면 초 단위가 필요하다
  const pkg = cardPkg(cardId);
  const ps = loadPkgStats(pkg); ps[cardId] = s; storePkgStats(pkg, ps);
  if (currentUser) FB.saveProgressEntries(currentUser.uid, pkg, { [cardId]: s }).catch(e => console.warn("[sync] 저장 실패", e));
}

function wrongCards() {
  const stats = loadStats();
  return CARDS.filter(c => stats[c.id] && stats[c.id].wrong);
}

// 출제 가중치. 안 본 카드가 가장 앞이고, 본 카드는 오래 안 나왔을수록 앞이다.
// 오답과 정답을 여기서 가르지 않는다 — 오답의 비율은 buildQueue 가 따로 묶어 정한다.
// (예전에는 오답 가중치가 맞힌 카드의 몇 배라, 안 본 카드가 떨어지면 같은 오답만
//  세션마다 되돌아왔다. 또 마지막 학습을 날짜로만 저장해 같은 날 안에서는
//  방금 본 카드와 아침에 본 카드를 구분하지 못했다.)
const W_NEW = 1000;          // 안 본 카드
const WRONG_SHARE = 0.4;     // 한 세션에서 오답 카드가 차지할 수 있는 최대 비율

function hoursSince(s) {
  if (!s || !s.last) return Infinity;
  const t = new Date(s.last).getTime();
  return isNaN(t) ? Infinity : Math.max(0, (Date.now() - t) / 3600000);
}

function cardWeight(c, stats) {
  const s = stats[c.id];
  if (!s) return W_NEW;
  const h = hoursSince(s);
  let w = 1 + h / 6;                       // 6시간마다 1씩 — 하루 5, 일주일 29, 한 달 121
  w /= 1 + (s.box || 0) * 0.25;            // 연속 정답이 쌓인 카드는 조금 덜 (box5 → 0.44배)
  return w;
}

// 한 세션의 출제 목록. 오답은 정해진 비율까지만 넣고, 나머지는 안 본 카드와
// 오래 안 나온 카드로 채운다. 오답만 몰아 풀려면 오답 노트 모드를 쓴다.
function buildQueue(pool, n) {
  const stats = loadStats();
  const wrongPool = pool.filter(c => stats[c.id] && stats[c.id].wrong);
  const restPool  = pool.filter(c => !(stats[c.id] && stats[c.id].wrong));

  const quota = Math.min(wrongPool.length, Math.floor(n * WRONG_SHARE));
  const picks = weightedSample(restPool, n - quota);
  const taken = new Set(picks.map(c => c.id));
  // 나머지 풀이 모자라면(범위 안이 거의 다 오답이면) 오답으로 채운다
  const need = n - picks.length;
  const fromWrong = weightedSample(wrongPool, Math.max(quota, need));
  fromWrong.forEach(c => { if (picks.length < n && !taken.has(c.id)) picks.push(c); });

  for (let i = picks.length - 1; i > 0; i--) {   // 오답이 한쪽에 몰리지 않게 섞는다
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks;
}

// 가중치를 반영한 비복원 추출
function weightedSample(pool, n) {
  const stats = loadStats();
  const items = pool.map(c => ({ c, w: cardWeight(c, stats) }));
  const out = [];
  while (out.length < n && items.length) {
    const total = items.reduce((sum, it) => sum + it.w, 0);
    let r = Math.random() * total, i = 0;
    for (; i < items.length - 1; i++) { r -= items[i].w; if (r <= 0) break; }
    out.push(items[i].c);
    items.splice(i, 1);
  }
  return out;
}

// ===== 글자 크기 =====
function loadFontScale() {
  const v = parseFloat(localStorage.getItem(FS_KEY));
  return FONT_SIZES.some(f => f.scale === v) ? v : FS_DEFAULT;
}
function applyFontScale(scale) {
  document.documentElement.style.setProperty("--fs", scale);
  try { localStorage.setItem(FS_KEY, String(scale)); } catch {}
}
function buildFontChips() {
  const el = document.getElementById("filter-fontsize");
  const cur = loadFontScale();
  el.innerHTML = "";
  FONT_SIZES.forEach(f => {
    const chip = document.createElement("span");
    chip.className = "chip" + (f.scale === cur ? " on" : "");
    chip.textContent = f.label;
    chip.onclick = () => {
      applyFontScale(f.scale);
      buildFontChips();          // 단일 선택이므로 다시 그린다
    };
    el.appendChild(chip);
  });
}

// ===== 화면 테마 (라이트/다크/시스템) =====
function loadTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return THEME_OPTIONS.some(t => t.value === v) ? v : THEME_DEFAULT;
}
function applyTheme(value) {
  if (value === "light" || value === "dark") {
    document.documentElement.setAttribute("data-theme", value);
  } else {
    document.documentElement.removeAttribute("data-theme");   // 시스템 설정을 따름
  }
  try { localStorage.setItem(THEME_KEY, value); } catch {}
}
function isDarkNow() {
  const t = loadTheme();
  if (t === "dark") return true;
  if (t === "light") return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
function buildThemeChips() {
  const el = document.getElementById("theme-toggle");
  if (!el) return;
  const cur = loadTheme();
  el.innerHTML = "";
  THEME_OPTIONS.forEach(t => {
    const chip = document.createElement("span");
    chip.className = "chip" + (t.value === cur ? " on" : "");
    chip.textContent = t.label;
    chip.onclick = () => { applyTheme(t.value); buildThemeChips(); };
    el.appendChild(chip);
  });
}
// 시스템 설정이 바뀌면(다크모드 예약 전환 등) '시스템' 선택 시 즉시 반영
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => { if (loadTheme() === "system") applyTheme("system"); };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

// ===== 클릭음 (Web Audio, 외부 파일 없음) =====
let audioCtx = null;
function playClick() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const lp = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();

    osc.type = "sine";                                   // 배음 없는 부드러운 파형
    osc.frequency.setValueAtTime(190, t);                // 낮고 묵직한 음역
    osc.frequency.exponentialRampToValueAtTime(115, t + 0.10);

    lp.type = "lowpass";                                 // 날카로운 고역 제거
    lp.frequency.setValueAtTime(650, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.20, t + 0.010);  // 완만한 어택 → 딸깍거림 억제
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13); // 여유 있는 감쇠

    osc.connect(lp); lp.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.14);
  } catch { /* 오디오 미지원 환경은 무시 */ }
}

// ===== 필터 UI =====
// 과목(단일 선택)이 정해지면 유형·시대·태그·중요도는 그 과목 카드에서만 뽑는다.
function subjectPool() {
  return selectedSubject ? CARDS.filter(c => c.과목 === selectedSubject) : CARDS;
}

function uniqueValues(key, pool) {
  const set = new Set();
  (pool || CARDS).forEach(c => {
    if (key === "태그") c.태그목록.forEach(t => set.add(t));
    else if (c[key]) set.add(c[key]);
  });
  const arr = [...set];
  return key === "중요도"
    ? arr.sort((a, b) => Number(a) - Number(b))
    : arr.sort((a, b) => a.localeCompare(b, "ko"));
}

// 과목: 단일 선택 (+ '전체' 옵션)
function buildSubjectChips() {
  const el = document.getElementById("filter-subject");
  el.innerHTML = "";
  const values = ["", ...uniqueValues("과목")];
  values.forEach(v => {
    const chip = document.createElement("span");
    chip.className = "chip" + (selectedSubject === v ? " on" : "");
    chip.textContent = v || "전체";
    chip.onclick = () => {
      selectedSubject = v;
      buildSubjectChips();
      rebuildDependentChips();   // 하위 항목 재생성 + 전체 선택
      updatePoolCount();
    };
    el.appendChild(chip);
  });
}

function buildChips(containerId, key, values) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  if (!values.length) {
    el.innerHTML = `<span class="empty">해당 항목 없음</span>`;
    return;
  }
  values.forEach(v => {
    const chip = document.createElement("span");
    chip.className = "chip" + (filters[key].has(v) ? " on" : "");
    chip.textContent = key === "중요도" ? `${v}등급` : v;
    chip.onclick = () => {
      if (filters[key].has(v)) { filters[key].delete(v); chip.classList.remove("on"); }
      else { filters[key].add(v); chip.classList.add("on"); }
      updatePoolCount();
    };
    el.appendChild(chip);
  });
}

// 현재 과목 범위에서 선택 가능한 전체 값 (전부 선택 여부 판정에 사용)
let allValues = { 유형: [], 시대: [], 태그: [], 중요도: [] };

// 과목 변경 시: 하위 칩을 다시 그리고 기본값으로 전부 선택한다.
function rebuildDependentChips() {
  const pool = subjectPool();
  DEP_KEYS.forEach(([key, id]) => {
    const values = uniqueValues(key, pool);
    allValues[key] = values;
    // 디폴트 전체 선택. 중요도만 1등급이 있으면 1등급만 — 핵심부터 돌리고 필요할 때 넓힌다.
    filters[key] = key === "중요도" && values.includes("1") ? new Set(["1"]) : new Set(values);
    buildChips(id, key, values);
  });
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function filteredPool() {
  const mode = getMode();
  // 값이 비어 있는 카드(시대 없음·태그 없음)는 해당 축을 전부 선택해 둔 동안에만 통과시킨다.
  // 일부만 골라 범위를 좁혔다면 분류 불가능한 카드로 보고 제외한다.
  const eraNarrowed = filters.시대.size < allValues.시대.length;
  const tagNarrowed = filters.태그.size < allValues.태그.length;
  return subjectPool().filter(c => {
    if (mode === "image" && !c.이미지링크) return false;
    if (!filters.유형.has(c.유형)) return false;
    if (!filters.중요도.has(c.중요도)) return false;
    if (c.시대) { if (!filters.시대.has(c.시대)) return false; }
    else if (eraNarrowed) return false;
    if (c.태그목록.length) { if (!c.태그목록.some(t => filters.태그.has(t))) return false; }
    else if (tagNarrowed) return false;
    return true;
  });
}

// 접힌 항목에도 무엇이 선택돼 있는지 보이도록 요약 줄에 선택 수를 적는다
function updateFilterSummaries() {
  document.querySelectorAll(".sel-count[data-for]").forEach(el => {
    const key = el.dataset.for, total = allValues[key].length, n = filters[key].size;
    const all = n === total;
    el.textContent = total ? (all ? "전체" : n === 0 ? "선택 없음" : `${n}/${total} 선택`) : "";
    el.classList.toggle("partial", !all);
  });
}
function updatePoolCount() {
  updateFilterSummaries();
  const n = filteredPool().length;
  const el = document.getElementById("pool-count");
  el.textContent = `선택 범위 카드: ${n}장`;
  el.classList.toggle("zero", n === 0);
  document.getElementById("btn-cardlist").disabled = n === 0;
  document.getElementById("mode-note").textContent =
    getMode() === "image" ? "(이미지 있는 카드만 대상)" : "";
}

// ===== 선택 범위 카드 목록 =====
// 지금 필터에 걸린 카드의 표제어를 과목별로 모아 새 창에 띄운다.
// 무엇을 공부하게 되는지 시작 전에 훑어보기 위한 것이라 표제어만 싣는다.
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function cardListHtml(pool) {
  const bySubj = new Map();
  pool.forEach(c => {
    if (!bySubj.has(c.과목)) bySubj.set(c.과목, []);
    bySubj.get(c.과목).push(c);
  });
  const cmp = (a, b) => a.표제어.localeCompare(b.표제어, "ko");
  const scope = [
    selectedSubject || "전체 과목",
    filters.유형.size < allValues.유형.length ? [...filters.유형].join("·") : "",
    getMode() === "image" ? "이미지 있는 카드" : "",
  ].filter(Boolean).join(" · ");

  const sections = [...bySubj.entries()].map(([subj, cards]) => `
    <section>
      <h2>${esc(subj)} <small>${cards.length}장</small></h2>
      <ol>${cards.sort(cmp).map(c =>
        `<li><a href="#" data-name="${esc(c.표제어)}">${esc(c.표제어)}</a><span class="t">${esc(c.유형)}</span></li>`).join("")}</ol>
    </section>`).join("");

  const dark = isDarkNow();
  const bg = dark ? "#1a1d23" : "#fff", fg = dark ? "#e4e6ea" : "#222";
  const scopeFg = dark ? "#9aa0a8" : "#666", hrColor = dark ? "#343841" : "#e3e6ea";
  const smallFg = dark ? "#767c87" : "#888", tFg = dark ? "#767c87" : "#8a94a6";
  const closeBg = dark ? "#2a2e36" : "#fff", closeBorder = dark ? "#454a54" : "#c9cfd8";
  const closeFg = dark ? "#5b8fdb" : "#2b5fb8", closeHoverBg = dark ? "#313847" : "#f0f4fb";

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>선택 범위 카드 ${pool.length}장</title>
<style>
  body { font-family: "Malgun Gothic", "맑은 고딕", sans-serif; margin: 0; padding: 20px 24px; color: ${fg}; background: ${bg}; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .scope { color: ${scopeFg}; font-size: 0.88rem; margin-bottom: 18px; }
  section { break-inside: avoid; margin-bottom: 18px; }
  h2 { font-size: 0.98rem; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid ${hrColor}; }
  h2 small { color: ${smallFg}; font-weight: normal; margin-left: 6px; }
  ol { margin: 0; padding-left: 26px; columns: 3; column-gap: 28px; }
  li { font-size: 0.92rem; line-height: 1.55; break-inside: avoid; }
  li a { color: inherit; text-decoration: none; border-bottom: 1px dotted ${tFg}; }
  li a:hover { color: ${closeFg}; border-bottom-color: ${closeFg}; }
  .t { font-size: 0.7rem; color: ${tFg}; margin-left: 5px; }
  @media (max-width: 860px) { ol { columns: 2; } }
  @media (max-width: 520px) { ol { columns: 1; } }
  @media print {
    body { padding: 0; color: #222; background: #fff; }
    h2 { border-bottom-color: #e3e6ea; } h2 small { color: #888; } .scope { color: #666; } .t { color: #8a94a6; }
    ol { columns: 3; } .close { display: none; }
  }
  .close { position: fixed; top: 10px; right: 12px; border: 1px solid ${closeBorder}; background: ${closeBg};
           color: ${closeFg}; padding: 6px 14px; border-radius: 8px; font-size: 0.9rem; cursor: pointer; }
  .close:hover { background: ${closeHoverBg}; }
</style></head><body>
<button type="button" class="close" id="close-list">닫기</button>
<script>
  // 같은 창 안(iframe)에 떠 있으면 부모가 닫고, 새 창이면 스스로 닫는다.
  // 홈 화면에 추가한 앱에서는 새 창에 탭 닫기가 없어 이 버튼이 유일한 출구다.
  const closeBtn = document.getElementById("close-list");
  if (window.parent !== window) closeBtn.style.display = "none";   // 오버레이에는 바깥에 닫기가 있다
  closeBtn.onclick = () => {
    window.close();
    setTimeout(() => { if (!window.closed) history.back(); }, 250);
  };
  // 항목을 누르면 앱 쪽에서 그 카드를 (학습 화면의 뒷면처럼) 미리보기로 연다
  document.addEventListener("click", e => {
    const a = e.target.closest("a[data-name]");
    if (!a) return;
    e.preventDefault();
    const target = window.parent !== window ? window.parent : window.opener;
    if (target) target.postMessage({ type: "open-card", name: a.dataset.name }, "*");
  });
</script>
<h1>선택 범위 카드 ${pool.length}장</h1>
<div class="scope">${esc(scope)}</div>
${sections}
</body></html>`;
}

// 새 창을 먼저 시도하고, 팝업이 막히면(모바일에서 흔하다) 같은 창 안에 덮어 띄운다.
function openCardList() {
  const pool = filteredPool();
  if (!pool.length) return;
  const html = cardListHtml(pool);
  const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  if (standalone || window.innerWidth < 700) { showCardListOverlay(html); return; }
  let win = null;
  try { win = window.open("", "_blank"); } catch { win = null; }
  if (win && win.document) {
    try {
      win.document.open(); win.document.write(html); win.document.close();
      return;
    } catch { try { win.close(); } catch {} }
  }
  showCardListOverlay(html);
}

function showCardListOverlay(html) {
  let el = document.getElementById("listbox");
  if (!el) {
    el = document.createElement("div");
    el.id = "listbox"; el.className = "peek";
    el.innerHTML =
      `<div class="peek-box listbox-box">
         <div class="peek-bar"><b>선택 범위 카드</b>
           <button type="button" class="ghost" id="listbox-close">닫기</button></div>
         <iframe id="listbox-frame" title="선택 범위 카드 목록"></iframe>
       </div>`;
    document.body.appendChild(el);
    el.querySelector("#listbox-close").onclick = () => el.remove();
    el.addEventListener("click", e => { if (e.target === el) el.remove(); });
  }
  el.querySelector("#listbox-frame").srcdoc = html;
}
window.addEventListener("message", e => {
  if (e.data === "close-listbox") { const el = document.getElementById("listbox"); if (el) el.remove(); }
});

// ===== 화면 전환 =====
const screens = ["login", "pending", "setup", "quiz", "result", "stats", "map", "me", "exam"];
function show(name) {
  screens.forEach(s => {
    const el = document.getElementById("screen-" + s);
    const on = s === name;
    if (on && el.classList.contains("hidden")) {   // 새로 나타나는 화면만 애니메이션
      el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    }
    el.classList.toggle("hidden", !on);
  });
  // 학습 수행 중·로그인 전에는 상단 네비게이션을 감춘다
  document.getElementById("main-nav").classList.toggle("hidden", name === "quiz" || name === "login" || name === "pending");
  document.getElementById("btn-settings").classList.toggle("hidden", name === "quiz");
  ["setup", "stats", "map", "me", "exam"].forEach(n => document.getElementById("nav-" + n).classList.toggle("active", name === n));
}

// ===== 학습 세션 =====
function sessionSize(poolLen) {
  return Math.min(parseInt(document.getElementById("session-count").value, 10) || 10, poolLen);
}

async function startSession() {
  await resyncIfStale();
  const pool = filteredPool();
  if (!pool.length) { alert("선택한 범위에 카드가 없습니다."); return; }
  session = {
    queue: buildQueue(pool, sessionSize(pool.length)),
    idx: 0, mode: getMode(), correct: 0, wrongCards: [], isReview: false,
  };
  show("quiz");
  renderCard();
}

// 오답 노트: 필터 범위를 무시하고 오답으로 기록된 카드만 출제
async function startReviewSession() {
  await resyncIfStale();
  let pool = wrongCards();
  if (!pool.length) { alert("오답으로 기록된 카드가 없습니다."); return; }
  if (getMode() === "image") {
    pool = pool.filter(c => c.이미지링크);
    if (!pool.length) { alert("오답 카드 중 이미지가 있는 것이 없습니다. 다른 제시 모드를 선택해 주세요."); return; }
  }
  session = {
    queue: weightedSample(pool, sessionSize(pool.length)),
    idx: 0, mode: getMode(), correct: 0, wrongCards: [], isReview: true,
  };
  show("quiz");
  renderCard();
}

function updateWrongCount() {
  const n = wrongCards().length;
  const btn = document.getElementById("btn-wrongnote");
  btn.textContent = n ? `오답 노트 (${n})` : "오답 노트";
  btn.disabled = n === 0;
}

function imgTag(c) {
  return c.이미지링크 ? `<img src="${c.이미지링크}" alt="${c.표제어}" loading="lazy">` : "";
}

// 표제어 + 원어 표기(한자·외국어)
function termTag(c) {
  const v = c.표제어변형 ? `<div class="term-var">${c.표제어변형}</div>` : "";
  return `<div class="term">${c.표제어}</div>${v}`;
}

// 축1~축4 = 이 카드가 물릴 수 있는 출제 각도. 빈 축은 건너뛴다.
// 각 축은 "라벨: 내용" 형식이며, 라벨이 없으면 본문만 표시한다.
function axisList(c) {
  return ["축1", "축2", "축3", "축4"]
    .map(k => (c[k] || "").trim())
    .filter(Boolean);
}

function axisHtml(list) {
  return list.map(t => {
    const i = t.indexOf(":");
    if (i > 0 && i <= 12) {
      return `<div class="axis"><span class="axis-label">${t.slice(0, i).trim()}</span>` +
             `<span>${t.slice(i + 1).trim()}</span></div>`;
    }
    return `<div class="desc">${t}</div>`;
  }).join("");
}

// 작품 카드의 캡션(작가·제목·연도). 시험은 이 정보를 주고 특징을 묻는다.
function capTag(c) {
  return c.캡션 ? `<div class="caption">${c.캡션}</div>` : "";
}

// 같은 태그를 공유하는 형제 카드. 태그가 이미 갈래를 담고 있으므로 별도 데이터 없이 나온다.
// 너무 넓은 태그(형제라 보기 어려운 것)는 제외한다.
const SIB_MAX = 8;
function siblings(c) {
  const out = [];
  c.태그목록.forEach(t => {
    const mates = CARDS.filter(x => x.id !== c.id && x.태그목록.includes(t));
    if (mates.length >= 1 && mates.length <= SIB_MAX) {
      out.push({ tag: t, names: mates.map(x => x.표제어) });
    }
  });
  return out;
}

// 관계 테이블(data/links.csv)에서 온 연결. 방향에 따라 이름이 뒤집혀 표시된다.
function relations(c) {
  return LINKS.get(c.표제어) || [];
}

// '상위'를 따라 뿌리까지 올라간 갈래 경로. 예: 로커 → [판화, 오목판화]
function ancestorPath(name) {
  if (typeof name !== "string") name = name.표제어;
  const up = [];
  const seen = new Set([name]);
  let cur = name;
  while (up.length < 6) {
    const p = (LINKS.get(cur) || []).find(r => r.rel === "상위");
    if (!p || seen.has(p.other)) break;
    up.push(p.other); seen.add(p.other); cur = p.other;
  }
  return up.reverse();          // 뿌리 → 바로 위 순서
}

// 어떤 카드의 바로 아래 자식들
function childrenOf(name) {
  return (LINKS.get(name) || []).filter(r => r.rel === "하위").map(r => r.other);
}

// 뒷면 하단의 접이식 '더 보기'. 회전 중에는 접혀 있어 흐름을 방해하지 않는다.
function exploreTag(c) {
  const rel = relations(c);

  // 같은 종류의 관계는 한 줄로 묶는다 (상위 6줄 → 상위 1줄)
  const byRel = new Map();
  rel.forEach(r => {
    if (!byRel.has(r.rel)) byRel.set(r.rel, []);
    byRel.get(r.rel).push(r);
  });

  // 이미 관계로 이어진 카드는 태그 형제에서 뺀다 (중복 방지)
  const linked = new Set(rel.map(r => r.other));
  const seenSib = new Set();
  const sib = siblings(c)
    .map(g => ({ tag: g.tag, names: g.names.filter(n => !linked.has(n)) }))
    // 앞선 태그가 이미 보여 준 이름은 뺀다. 태그가 겹쳐 같은 목록이 되풀이되는 것을 막는다.
    .map(g => {
      const names = g.names.filter(n => !seenSib.has(n));
      names.forEach(n => seenSib.add(n));
      return { tag: g.tag, names };
    })
    .filter(g => g.names.length);

  // 표제어는 버튼으로 만들어, 누르면 그 카드를 미리보기로 띄운다
  const chip = n => `<button type="button" class="link-card" data-name="${n}">${n}</button>`;

  // 상위 사슬을 끝까지 따라 올라간 갈래 경로와, 부모의 다른 자식(곁갈래)
  const path = ancestorPath(c);
  const aside = path.length ? childrenOf(path[path.length - 1])
                              .filter(n => n !== c.표제어 && !path.includes(n)) : [];
  let head = "";
  if (path.length) {
    head += `<div class="rel-row"><span class="rel-kind">갈래</span>` +
            path.map(chip).join(`<span class="crumb">›</span>`) + `</div>`;
  }
  if (aside.length) {
    head += `<div class="rel-row"><span class="rel-kind">곁갈래</span>` +
            aside.map(chip).join("") + `</div>`;
  }
  // 경로·곁갈래로 이미 보여 준 카드는 아래에서 다시 보여 주지 않는다
  const shown = new Set([...path, ...aside]);
  aside.forEach(n => seenSib.add(n));
  byRel.forEach((list, kind) => {
    const kept = list.filter(r => !(kind === "상위" && shown.has(r.other)));
    if (kept.length) byRel.set(kind, kept); else byRel.delete(kind);
  });

  if (!head && !byRel.size && !sib.length) return "";

  let body = head;
  byRel.forEach((list, kind) => {
    const items = list.map(r =>
      chip(r.other) + (r.memo ? `<span class="rel-memo">${r.memo}</span>` : "")).join("");
    body += `<div class="rel-row"><span class="rel-kind">${kind}</span>${items}</div>`;
  });
  sib.forEach(g => {
    body += `<div class="sib-row"><span class="sib-tag">${g.tag}</span>` +
            g.names.map(chip).join("") + `</div>`;
  });
  return `<div class="explore"><div class="explore-body">${body}</div></div>`;
}

// ===== 관련 항목 미리보기 =====
// 회전 중에 다른 카드를 잠깐 들여다보기 위한 겹침 화면.
// 세션 큐와 채점에는 전혀 영향을 주지 않으며, 닫으면 원래 카드로 돌아온다.
let peekStack = [];

function cardByName(name) {
  return CARDS.find(c => c.표제어 === name);
}

function ensurePeek() {
  let el = document.getElementById("peek");
  if (el) return el;
  el = document.createElement("div");
  el.id = "peek";
  el.className = "peek hidden";
  el.innerHTML =
    `<div class="peek-box">
       <div class="peek-bar">
         <button type="button" id="peek-back" class="ghost">← 뒤로</button>
         <span id="peek-path" class="peek-path"></span>
         <button type="button" id="peek-close" class="ghost">닫기 ✕</button>
       </div>
       <div id="peek-body" class="card-face"></div>
     </div>`;
  document.body.appendChild(el);
  el.onclick = e => { if (e.target === el) closePeek(); };          // 바깥 클릭
  el.querySelector("#peek-close").onclick = closePeek;
  el.querySelector("#peek-back").onclick = () => {
    peekStack.pop();
    peekStack.length ? renderPeek() : closePeek();
    playClick();
  };
  return el;
}

function renderPeek() {
  const c = peekStack[peekStack.length - 1];
  const el = ensurePeek();
  el.classList.remove("hidden");
  el.querySelector("#peek-back").style.visibility = peekStack.length > 1 ? "" : "hidden";
  el.querySelector("#peek-path").textContent = peekStack.map(x => x.표제어).join(" › ");
  el.querySelector("#peek-body").innerHTML =
    termTag(c) +
    `<div class="meta">${c.과목} · ${c.유형}${c.시대 ? " · " + c.시대 : ""}</div>` +
    capTag(c) + axisHtml(axisList(c)) + imgTag(c) + srcTag(c) + exploreTag(c);
  el.querySelector(".peek-box").scrollTop = 0;
}

function openPeek(name) {
  const c = cardByName(name);
  if (!c) return;
  peekStack.push(c);
  renderPeek();
  playClick();
}

function closePeek() {
  peekStack = [];
  const el = document.getElementById("peek");
  if (el) el.classList.add("hidden");
}

// 기출 출처(연도+과목+문항). 개수가 곧 빈출도다.
// 출처 태그(예: 2026A7)가 기출문제 뷰어에 있는 문항이면 눌러서 원문을 볼 수 있게 한다
function examQuestionFor(tag) {
  const m = /^(\d{4}[AB])(\d{1,2})$/.exec(tag);
  if (!m || !EXAMS) return null;
  const entry = EXAMS.find(e => e.id === m[1]);
  const idx = entry ? entry.questions.findIndex(q => q.n === +m[2]) : -1;
  return idx >= 0 ? { id: m[1], idx } : null;
}
function srcTag(c) {
  const s = (c.출처 || "").split(";").map(x => x.trim()).filter(Boolean);
  if (!s.length) return "";
  const items = s.map(t => {
    const q = examQuestionFor(t);
    return q ? `<button type="button" class="src-link" data-exam="${q.id}" data-idx="${q.idx}" title="기출 문항 원문 보기">${esc(t)} ↗</button>` : esc(t);
  });
  return `<div class="src">기출 ${s.length}회 · ${items.join(", ")}</div>`;
}
// 문항 이미지 확대: 배율은 이미지 폭(%)으로 주고, 넘치는 부분은 패널 안에서 스크롤한다.
const ZOOM_STEPS = [1, 1.5, 2, 3];
function zoomBar(prefix) {
  return `<div class="zoom-bar">
    <button type="button" class="mini" data-zoom="out" data-for="${prefix}">−</button>
    <span class="zoom-val" id="${prefix}-zoom-val">100%</span>
    <button type="button" class="mini" data-zoom="in" data-for="${prefix}">＋</button>
    <button type="button" class="mini" data-zoom="fit" data-for="${prefix}">맞춤</button>
    <span class="hint">두 번 탭: 확대/원래대로 · 손가락 벌려 확대도 됩니다</span>
  </div>`;
}
function setZoom(prefix, z) {
  const panel = document.getElementById(prefix + "-panel");
  const img = panel.querySelector("img");
  img.style.width = (z * 100) + "%";
  panel.dataset.zoom = z;
  const v = document.getElementById(prefix + "-zoom-val"); if (v) v.textContent = Math.round(z * 100) + "%";
}
function stepZoom(prefix, dir) {
  const cur = +(document.getElementById(prefix + "-panel").dataset.zoom || 1);
  if (dir === "fit") return setZoom(prefix, 1);
  const i = ZOOM_STEPS.indexOf(cur);
  const n = dir === "in" ? Math.min(i + 1, ZOOM_STEPS.length - 1) : Math.max(i - 1, 0);
  setZoom(prefix, ZOOM_STEPS[n < 0 ? 0 : n]);
}
function wireDoubleTap(prefix) {
  const panel = document.getElementById(prefix + "-panel");
  let last = 0;
  panel.addEventListener("click", e => {
    const now = Date.now();
    if (now - last < 320) {
      const cur = +(panel.dataset.zoom || 1);
      const rect = panel.getBoundingClientRect();
      const rx = (e.clientX - rect.left + panel.scrollLeft) / panel.scrollWidth;
      const ry = (e.clientY - rect.top + panel.scrollTop) / panel.scrollHeight;
      const z = cur > 1 ? 1 : 2;
      setZoom(prefix, z);
      // 탭한 지점이 계속 보이도록 스크롤 위치를 맞춘다
      requestAnimationFrame(() => {
        panel.scrollLeft = rx * panel.scrollWidth - (e.clientX - rect.left);
        panel.scrollTop = ry * panel.scrollHeight - (e.clientY - rect.top);
      });
    }
    last = now;
  });
}

// 학습 중에도 세션을 깨지 않도록 문항은 겹창으로 띄운다
function openExamPeek(id, idx) {
  const entry = EXAMS && EXAMS.find(e => e.id === id);
  const q = entry && entry.questions[idx];
  if (!q) return;
  let el = document.getElementById("exam-peek");
  if (!el) {
    el = document.createElement("div");
    el.id = "exam-peek"; el.className = "peek";
    el.innerHTML = `<div class="peek-box exam-peek-box">
        <div class="peek-bar"><b id="exam-peek-title"></b><span class="peek-path"></span>
          <button type="button" class="ghost hidden" id="exam-peek-answer">답 보기</button>
          <button type="button" class="ghost" id="exam-peek-close">닫기</button></div>
        ${zoomBar("exam-peek")}
        <div class="exam-q-panel" id="exam-peek-panel"><img id="exam-peek-img" alt="기출 문항"></div>
        <div id="exam-peek-ans" class="exam-answer hidden"></div>
      </div>`;
    document.body.appendChild(el);
    wireDoubleTap("exam-peek");
    el.querySelector("#exam-peek-close").onclick = () => el.classList.add("hidden");
    el.addEventListener("click", e => { if (e.target === el) el.classList.add("hidden"); });
    // 학습 중에도 답을 확인할 수 있게 — 기출문제 탭과 같은 참고 답안·관련 카드
    el.querySelector("#exam-peek-answer").onclick = () => {
      const p = el._peek; if (p) toggleAnswerBox(p.entry, p.q, el.querySelector("#exam-peek-ans"), el.querySelector("#exam-peek-answer"));
    };
  }
  el._peek = { entry, q };
  el.querySelector("#exam-peek-title").textContent = `${entry.title} ${q.n}번${q.points ? ` (${q.points}점)` : ""}`;
  el.querySelector("#exam-peek-img").src = q.img;
  setZoom("exam-peek", 1);
  const ansBox = el.querySelector("#exam-peek-ans"), ansBtn = el.querySelector("#exam-peek-answer");
  ansBox.classList.add("hidden"); ansBox.innerHTML = ""; ansBtn.textContent = "답 보기"; ansBtn.classList.add("hidden");
  loadAnswers(examTag(entry)).then(d => ansBtn.classList.toggle("hidden", !(d && d.answers)));
  el.classList.remove("hidden");
  el.querySelector(".peek-box").scrollTop = 0;
}

// ===== 힌트 (표제어를 인출해야 하는 모드에서만: 설명 제시·이미지 제시) =====
// 1단계: 글자 수 → 2단계: 초성. 완전히 막혔을 때 인출을 포기하지 않도록 돕는 최소 단서.
const CHOSEONG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
function choseongOf(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  return (code >= 0 && code <= 11171) ? CHOSEONG[Math.floor(code / 588)] : ch;
}
function hintUsesTerm(mode) { return mode === "desc" || mode === "image"; }
function hintCharCount(term) { return [...term].filter(ch => ch !== " ").length; }
function hintInitials(term) { return [...term].map(ch => (ch === " " ? " " : choseongOf(ch))).join(""); }
function updateHintUI() {
  const btn = document.getElementById("btn-hint");
  const line = document.getElementById("hint-line");
  if (!btn || !line) return;
  const c = session.queue[session.idx];
  if (session.hintLevel === 0) { line.textContent = ""; btn.textContent = "힌트"; btn.disabled = false; }
  else if (session.hintLevel === 1) { line.textContent = `${hintCharCount(c.표제어)}자`; btn.textContent = "힌트 (초성)"; btn.disabled = false; }
  else { line.textContent = hintInitials(c.표제어); btn.textContent = "힌트 완료"; btn.disabled = true; }
}
function useHint() {
  if (session.hintLevel >= 2) return;
  session.hintLevel++;
  session.hintUsed = true;
  updateHintUI();
  playClick();
}

function renderCard() {
  const c = session.queue[session.idx];
  const front = document.getElementById("card-front");
  const back = document.getElementById("card-back");
  const ax = axisList(c);
  // 앞면에는 시대를 넣지 않는다 (답을 흘리게 된다). 시대는 뒷면에서 보여 준다.
  const metaFront = `<div class="meta">${c.과목} · ${c.유형} · 중요도 ${c.중요도}</div>`;
  const metaBack = c.시대 ? `<div class="meta">${c.시대}</div>` : "";
  const extra = srcTag(c) + metaBack + exploreTag(c);
  const hintLine = `<div class="hint-line" id="hint-line"></div>`;

  session.hintLevel = 0;
  session.hintUsed = false;

  if (session.mode === "term") {
    front.innerHTML = termTag(c) + metaFront;
    back.innerHTML = capTag(c) + axisHtml(ax) + imgTag(c) + extra;
  } else if (session.mode === "desc") {
    // 첫 축만 제시하고 표제어를 인출한다. 나머지 축은 답과 함께 공개.
    front.innerHTML = axisHtml(ax.slice(0, 1)) + hintLine + metaFront;
    back.innerHTML = termTag(c) + capTag(c) + axisHtml(ax.slice(1)) + imgTag(c) + extra;
  } else { // image
    // 도판만 주고 표제어를 인출한다.
    // 캡션에는 대개 작가와 작품명이 적혀 있어(예: "정선, 〈금강전도〉, 1734")
    // 앞면에 두면 그대로 답이 된다. 캡션은 뒷면에서 공개한다.
    front.innerHTML = imgTag(c) + hintLine + metaFront;
    back.innerHTML = termTag(c) + capTag(c) + axisHtml(ax) + extra;
  }
  back.classList.add("hidden");
  document.getElementById("btn-reveal").classList.remove("hidden");
  document.getElementById("judge-buttons").classList.add("hidden");
  document.getElementById("report-box").classList.add("hidden");
  const hintBtn = document.getElementById("btn-hint");
  if (hintBtn) hintBtn.classList.toggle("hidden", !hintUsesTerm(session.mode));
  updateHintUI();
  document.getElementById("quiz-progress").textContent =
    `${session.isReview ? "오답 노트 · " : ""}${session.idx + 1} / ${session.queue.length}`;
}

function reveal() {
  document.getElementById("card-back").classList.remove("hidden");
  document.getElementById("btn-reveal").classList.add("hidden");
  document.getElementById("btn-hint").classList.add("hidden");
  document.getElementById("judge-buttons").classList.remove("hidden");
  document.getElementById("report-box").classList.remove("hidden");
  updateReportUI();
}

// ===== 카드 신고 ("이상해요") =====
const REPORT_REASONS = [
  "설명이 틀렸거나 부정확함",
  "답이 여러 개 가능 (모호함)",
  "앞면에 답이 드러남",
  "오타·표기 오류",
  "이미지가 안 보이거나 잘못됨",
  "너무 지엽적·시험과 무관",
  "다른 카드와 중복",
];
function buildReportReasons() {
  const box = document.getElementById("report-reasons");
  box.innerHTML = REPORT_REASONS.map(r => `<span class="chip" data-reason="${esc(r)}">${esc(r)}</span>`).join("");
  box.onclick = e => {
    const chip = e.target.closest(".chip");
    if (chip) chip.classList.toggle("on");
  };
}
function selectedReasons() {
  return [...document.querySelectorAll("#report-reasons .chip.on")].map(el => el.dataset.reason);
}
// 이 기기에서 이미 신고한 카드는 다시 보내지 않도록 기억해 둔다 (표시용이라 로컬로 충분)
const REPORTED_KEY = "flashcard-reported-v1";
function reportedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(REPORTED_KEY)) || []); } catch { return new Set(); }
}
function markReported(cardId) {
  const s = reportedSet(); s.add(String(cardId));
  try { localStorage.setItem(REPORTED_KEY, JSON.stringify([...s])); } catch {}
}
function updateReportUI() {
  const c = session && session.queue[session.idx];
  const btn = document.getElementById("btn-report");
  const done = c && reportedSet().has(String(c.id));
  btn.textContent = done ? "신고됨 ✓" : "이상해요";
  btn.classList.toggle("done", !!done);
  btn.disabled = !!done;
  document.getElementById("report-form").classList.add("hidden");
  document.getElementById("report-note").value = "";
  document.querySelectorAll("#report-reasons .chip.on").forEach(el => el.classList.remove("on"));
}
async function sendReport() {
  const c = session.queue[session.idx];
  const reasons = selectedReasons();
  const note = document.getElementById("report-note").value.trim().slice(0, 500);
  if (!reasons.length && !note) { alert("이유를 하나 이상 고르거나 내용을 적어 주세요."); return; }
  const btn = document.getElementById("btn-report-send");
  btn.disabled = true;
  try {
    await FB.addReport({ pkg: c.pkg, major: MAJOR, cardId: String(c.id), 표제어: c.표제어, mode: session.mode, reasons, note });
    markReported(c.id);
    updateReportUI();
  } catch (e) {
    alert("신고를 보내지 못했습니다: " + (e && e.message || e));
  } finally { btn.disabled = false; }
}

function judge(isCorrect) {
  const c = session.queue[session.idx];
  saveResult(c.id, isCorrect, session.hintUsed);
  if (isCorrect) session.correct++;
  else session.wrongCards.push(c);
  session.idx++;
  if (session.idx < session.queue.length) renderCard();
  else finishSession();
}

function finishSession() {
  const total = session.queue.length;
  const pct = Math.round(session.correct / total * 100);
  document.getElementById("result-summary").textContent =
    `${total}문항 중 ${session.correct}개 정답 (${pct}%)`;

  const parts = [];
  if (session.isReview && session.correct) {
    parts.push(`<p class="cleared">✅ ${session.correct}장이 오답 노트에서 빠졌습니다 (남은 오답 ${wrongCards().length}장)</p>`);
  }
  if (session.wrongCards.length) {
    parts.push(`<h3>틀린 카드</h3><ul>` +
      session.wrongCards.map(c => `<li><b>${c.표제어}</b> — ${c.과목}</li>`).join("") + `</ul>`);
  }
  document.getElementById("result-wrong-list").innerHTML = parts.join("");
  updateWrongCount();
  show("result");
  // 세션이 끝난 김에 다른 기기 기록을 받아 둔다 — 이어서 보는 약점 지도·오답 노트가 최신이 되도록
  resyncIfStale().then(updateWrongCount);
}

// ===== 통계 화면 =====
function aggregate(keyFn) {
  const stats = loadStats();
  const groups = {};
  CARDS.forEach(c => {
    const s = stats[c.id];
    if (!s) return;
    keyFn(c).forEach(k => {
      if (!k) return;
      const g = groups[k] || { tries: 0, correct: 0 };
      g.tries += s.tries; g.correct += s.correct;
      groups[k] = g;
    });
  });
  return Object.entries(groups).sort((a, b) => b[1].tries - a[1].tries);
}

function renderStatsTable(tableId, entries) {
  const el = document.getElementById(tableId);
  if (!entries.length) { el.innerHTML = `<tr><td>기록 없음</td></tr>`; return; }
  let html = `<tr><th>구분</th><th class="num">수행</th><th class="num">정답률</th><th class="bar-cell"></th></tr>`;
  entries.forEach(([k, g]) => {
    const pct = Math.round(g.correct / g.tries * 100);
    const cls = pct < 60 ? "low" : pct < 80 ? "mid" : "";
    html += `<tr><td>${k}</td><td class="num">${g.tries}</td><td class="num">${pct}%</td>
      <td class="bar-cell"><div class="bar ${cls}"><i style="width:${pct}%"></i></div></td></tr>`;
  });
  el.innerHTML = html;
}

// 전체 진도: 카드 몇 장을 건드렸는지(커버리지)와 몇 번 맞고 틀렸는지(채점)를 함께 본다.
// 표들이 '시도 횟수' 기준이라 '전체 809장 중 어디까지 왔는지'가 드러나지 않아 따로 둔다.
const OV_BUCKETS = [
  { key: "done",     label: "완료",      color: "#1e8e4e", hint: "5회 연속 정답" },
  { key: "familiar", label: "거의 외움",  color: "#6cbf7a", hint: "3~4회 연속 정답" },
  { key: "learning", label: "익히는 중",  color: "#d9932c", hint: "1~2회 연속 정답" },
  { key: "wrong",    label: "오답",      color: "#c0392b", hint: "마지막에 틀림" },
  { key: "new",      label: "미학습",     color: "#c3c8cf", hint: "아직 안 본 카드" },
];

// 예상 점수: 시험 총점 80점(전공A 40 + 전공B 40) × 진행 비율 × 정답률.
// 카드마다 중요도 가중치를 둔다 — 시험은 핵심(1등급)에서 더 많이 나오므로 그쪽 진도·정답이 점수에 더 크게 잡힌다.
const IMP_WEIGHT = { "1": 3, "2": 2, "3": 1, "4": 0.5 };
// 패키지(교육학 20점, 전공 80점)마다 따로 계산해 합산한다.
function estimateScore(stats) {
  const parts = PKGS.map(pkg => {
    let wAll = 0, wSeen = 0, wAcc = 0;
    CARDS.filter(c => c.pkg === pkg).forEach(c => {
      const w = IMP_WEIGHT[c.중요도] || 1;
      wAll += w;
      const s = stats[c.id];
      if (!s || !s.tries) return;
      wSeen += w;
      wAcc += w * (s.correct / s.tries);
    });
    const progress = wAll ? wSeen / wAll : 0, accuracy = wSeen ? wAcc / wSeen : 0;
    const total = +((CONFIG[pkg] || {}).examTotal) || 0;
    return { pkg, label: (CONFIG[pkg] || {}).examLabel || pkg, total, progress, accuracy, score: Math.round(total * progress * accuracy) };
  });
  return { parts, total: parts.reduce((a, p) => a + p.total, 0), score: parts.reduce((a, p) => a + p.score, 0) };
}

function renderOverview() {
  const stats = loadStats();
  const total = CARDS.length;
  const est = estimateScore(stats);
  const estHtml = `
    <div class="est">
      <div class="est-label">현재 상태 예상 점수</div>
      <div class="est-score">${est.score}<small>점 / ${est.total}점</small></div>
      <div class="est-sub">${est.parts.map(p => `${esc(p.label)} ${p.score}/${p.total}점 (진행 ${Math.round(p.progress * 100)}% × 정답률 ${Math.round(p.accuracy * 100)}%)`).join(" + ")}
        <span class="hint">(중요도 1등급 카드에 더 큰 가중치)</span></div>
    </div>`;
  const b = { done: 0, familiar: 0, learning: 0, wrong: 0, new: 0 };
  let seen = 0, tries = 0, correct = 0;

  CARDS.forEach(c => {
    const s = stats[c.id];
    if (!s) { b.new++; return; }
    seen++; tries += s.tries; correct += s.correct;
    const box = s.box || 0;
    if (s.wrong) b.wrong++;
    else if (box >= 5) b.done++;
    else if (box >= 3) b.familiar++;
    else b.learning++;
  });

  const wrong = tries - correct;
  const pct = tries ? Math.round(correct / tries * 100) : 0;
  const seenPct = total ? Math.round(seen / total * 100) : 0;

  // 단위만 숫자 옆에 붙이고 긴 보조 문구는 아랫줄로 내린다.
  // 그래야 칸의 최소 너비가 작아져 좁은 화면에서도 그리드가 접힌다.
  const nums = `
    <div class="ov-nums">
      <div class="ov-num"><div class="k">학습한 카드</div>
        <div class="v">${seen}<small>장</small></div>
        <div class="sub">${total}장 중 ${seenPct}%</div></div>
      <div class="ov-num"><div class="k">아직 안 본 카드</div>
        <div class="v">${b.new}<small>장</small></div></div>
      <div class="ov-num ok"><div class="k">맞힘</div>
        <div class="v">${correct}<small>회</small></div></div>
      <div class="ov-num no"><div class="k">틀림</div>
        <div class="v">${wrong}<small>회</small></div></div>
      <div class="ov-num"><div class="k">누적 정답률</div>
        <div class="v">${pct}<small>%</small></div></div>
    </div>`;

  const seg = OV_BUCKETS
    .filter(x => b[x.key] > 0)
    .map(x => `<i style="width:${b[x.key] / total * 100}%;background:${x.color}"
                  title="${x.label} ${b[x.key]}장"></i>`).join("");
  const legend = OV_BUCKETS
    .map(x => `<span><b style="background:${x.color}"></b>${x.label} ${b[x.key]}장</span>`)
    .join("");

  document.getElementById("stats-overview").innerHTML =
    estHtml + nums +
    `<div class="stack">${seg}</div>` +
    `<div class="legend">${legend}</div>` +
    `<div class="ov-note">막대는 카드 ${total}장을 숙련도로 나눈 것입니다. ` +
    `맞히면 한 칸 오르고 틀리면 처음으로 돌아갑니다.</div>`;
}

function renderStats() {
  renderOverview();
  renderStatsTable("stats-subject", aggregate(c => [c.과목]));
  renderStatsTable("stats-type", aggregate(c => [c.유형]));
  renderStatsTable("stats-tag", aggregate(c => c.태그목록));

  // 취약 카드: 시도 2회 이상, 정답률 낮은 순
  const stats = loadStats();
  const weak = CARDS
    .map(c => ({ c, s: stats[c.id] }))
    .filter(x => x.s && x.s.tries >= 2)
    .map(x => ({ ...x, pct: Math.round(x.s.correct / x.s.tries * 100) }))
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 10);
  const el = document.getElementById("stats-weak");
  el.innerHTML = weak.length
    ? `<tr><th>표제어</th><th>과목</th><th class="num">수행</th><th class="num">정답률</th></tr>` +
      weak.map(x => `<tr><td><b>${x.c.표제어}</b></td><td>${x.c.과목}</td><td class="num">${x.s.tries}</td><td class="num">${x.pct}%</td></tr>`).join("")
    : `<tr><td>기록 없음 (같은 카드를 2회 이상 학습하면 표시됩니다)</td></tr>`;
}

// ===== 약점 지도 (과목x유형x시대 영역별 그리드) =====
// 카드를 성격이 뚜렷한 100여 개 영역으로 나누고, 영역마다 학습량·정답률을 색으로 보여준다.
// 칸을 누르면 그 영역만으로 바로 학습을 시작한다(설정 화면을 거치지 않음).
// 목표: 영역 하나당 카드 수를 비슷하게(AREA_TARGET 안팎) 맞춘다.
// 과목x유형x시대로 먼저 나눈 뒤, 시대별 조각이 너무 작으면(< AREA_MERGE_MIN) 시대순으로
// 이웃과 합치고, 너무 크면(> AREA_SPLIT_MAX) 표제어 가나다순으로 잘라 여러 조각으로 쪼갠다.
const AREA_TARGET = 16, AREA_MERGE_MIN = 8, AREA_SPLIT_MAX = 28;
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".split("");
function partLabel(i) { return CIRCLED[i] || `(${i + 1})`; }

function buildAreas() {
  // 1) 과목x유형x시대로 1차 분류
  const bySubjType = new Map();
  CARDS.forEach(c => {
    const stKey = `${c.과목}·${c.유형}`;
    if (!bySubjType.has(stKey)) bySubjType.set(stKey, new Map());
    const eraMap = bySubjType.get(stKey);
    const era = c.시대 || "";
    if (!eraMap.has(era)) eraMap.set(era, []);
    eraMap.get(era).push(c);
  });

  const areas = [];
  bySubjType.forEach((eraMap, stKey) => {
    const [subj, typ] = stKey.split("·");
    const eraGroups = [...eraMap.entries()].sort((a, b) => a[0].localeCompare(b[0], "ko"));

    // 2) 작은 시대 조각을 이웃과 합친다 (시대순으로 누적)
    const merged = [];
    let buf = null;
    eraGroups.forEach(([era, cards]) => {
      if (!buf) buf = { eras: era ? [era] : [], cards: [...cards] };
      else if (buf.cards.length < AREA_MERGE_MIN) {
        buf.cards.push(...cards);
        if (era) buf.eras.push(era);
      } else {
        merged.push(buf);
        buf = { eras: era ? [era] : [], cards: [...cards] };
      }
    });
    if (buf) merged.push(buf);
    if (merged.length >= 2 && merged[merged.length - 1].cards.length < AREA_MERGE_MIN) {
      const last = merged.pop();
      merged[merged.length - 1].cards.push(...last.cards);
      merged[merged.length - 1].eras.push(...last.eras);
    }

    // 3) 너무 큰 덩어리는 표제어 가나다순으로 목표 크기에 맞춰 쪼갠다
    merged.forEach(g => {
      const eraLabel = g.eras.length === 0 ? "" :
        g.eras.length <= 2 ? g.eras.join("·") : `${g.eras[0]}~${g.eras[g.eras.length - 1]}`;
      const n = g.cards.length;
      if (n <= AREA_SPLIT_MAX) {
        areas.push({ key: `${stKey}·${eraLabel}`, 과목: subj, 유형: typ, eraLabel, cards: g.cards });
        return;
      }
      const sorted = [...g.cards].sort((a, b) => a.표제어.localeCompare(b.표제어, "ko"));
      const parts = Math.max(1, Math.round(n / AREA_TARGET));
      const size = Math.ceil(n / parts);
      for (let i = 0; i < parts; i++) {
        const chunk = sorted.slice(i * size, (i + 1) * size);
        if (!chunk.length) continue;
        areas.push({
          key: `${stKey}·${eraLabel}·part${i}`, 과목: subj, 유형: typ, eraLabel,
          cards: chunk, part: partLabel(i),
          range: `${chunk[0].표제어}~${chunk[chunk.length - 1].표제어}`,
        });
      }
    });
  });
  return areas;
}
function scoreArea(area) {
  const stats = loadStats();
  let seen = 0, sum = 0, tries = 0, correct = 0, lastAt = "";
  area.cards.forEach(c => {
    const s = stats[c.id];
    if (!s) return;
    seen++; tries += s.tries; correct += s.correct;
    if (s.last && s.last > lastAt) lastAt = s.last;
    const box = s.box || 0;
    sum += s.wrong ? 0 : box >= 5 ? 1 : box >= 3 ? 0.85 : 0.5;
  });
  const total = area.cards.length;
  return {
    total, seen, tries, correct, lastAt,
    seenRatio: total ? seen / total : 0,
    avg: seen ? sum / seen : 0,
    pct: tries ? Math.round(correct / tries * 100) : null,
  };
}
function areaColor(score) {
  if (score.seenRatio < 0.1) return "#9aa0a8";        // 거의 안 봄 (중립 회색)
  if (score.avg < 0.35) return "#c0392b";             // 취약 (빨강) — 오답이 섞여야만 여기 온다
  if (score.avg < 0.7) return "#d9932c";              // 익히는 중 (주황)
  return "#1e8e4e";                                    // 잘함 (초록)
}
function renderMap() {
  const areas = buildAreas().sort((a, b) =>
    a.과목.localeCompare(b.과목, "ko") || a.유형.localeCompare(b.유형, "ko") ||
    a.eraLabel.localeCompare(b.eraLabel, "ko") || (a.part || "").localeCompare(b.part || ""));
  const el = document.getElementById("area-grid");
  const scores = new Map(areas.map(a => [a.key, scoreArea(a)]));
  // 최근에 학습한 영역 5개는 테두리로 표시 — 어디까지 했는지 한눈에 이어 보기 위해
  const RECENT_N = 5;
  const recent = new Set([...scores.entries()].filter(([, s]) => s.lastAt).sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))
    .slice(0, RECENT_N).map(([k]) => k));
  el.innerHTML = areas.map(area => {
    const score = scores.get(area.key);
    const color = areaColor(score);   // 영역당 카드가 적어 진도는 칸 안의 숫자(본/전체)로 충분하다 — 색만으로 상태를 읽게 한다
    const subj = subjectAbbr(area.과목);
    const sub = [area.eraLabel, area.part].filter(Boolean).join(" ");
    const label = sub ? `${subj}·${area.유형}<br>${sub}` : `${subj}·${area.유형}`;
    const title = `${area.과목} · ${area.유형}${area.eraLabel ? " · " + area.eraLabel : ""}` +
      (area.part ? ` · ${area.part} (${area.range})` : "") + `\n` +
      `${score.seen}/${score.total}장 학습` + (score.pct !== null ? ` · 정답률 ${score.pct}%` : "");
    return `<button type="button" class="area-cell${recent.has(area.key) ? " recent" : ""}" data-key="${esc(area.key)}"
              style="background:${color}" title="${esc(title)}${recent.has(area.key) ? "\n최근 학습" : ""}">
              <span class="area-label">${label}</span>
              <span class="area-count">${score.seen}/${score.total}</span>
            </button>`;
  }).join("");
}
async function startAreaSession(key) {
  await resyncIfStale();
  const area = buildAreas().find(a => a.key === key);
  if (!area || !area.cards.length) return;
  session = {
    queue: buildQueue(area.cards, sessionSize(area.cards.length)),
    idx: 0, mode: getMode(), correct: 0, wrongCards: [], isReview: false, origin: "map",
  };
  show("quiz");
  renderCard();
}
// 학습을 마치거나 중단했을 때, 지도에서 들어왔다면 지도로 돌려보낸다.
function backFromSession() {
  if (updatePending) { location.reload(); return; }
  if (session && session.origin === "map") { renderMap(); show("map"); }
  else show("setup");
}

// ===== 초기화 =====
// ===== 자동 갱신 =====
// 열려 있는 탭은 스스로 새 코드·새 카드를 받지 않는다. 앱이 화면에 다시 나타날 때
// index.html 의 스크립트 해시와 카드 번들 해시를 확인해, 바뀌었으면 새로고침한다.
// 학습 중이면 끊지 않고 띠만 띄우고, 세션이 끝나 설정 화면으로 돌아올 때 적용한다.
let updatePending = null, lastUpdateCheck = 0;
const UPDATE_MIN_GAP = 60 * 1000;
function appVersion() {
  const m = document.querySelector('meta[name="app-version"]');
  return m ? m.content : "";
}
function dataVersion() {
  return PKGS.map(p => `${(CONFIG[p] || {}).name || p} ${FB.cachedBundle(p, "cards").label || "-"}`).join(" · ");
}
function runningAppHash() {
  const m = /app\.js\?v=([0-9a-f]+)/.exec(document.querySelector('script[src*="app.js"]').src);
  return m ? m[1] : "";
}
async function latestAppHash() {
  // 캐시(브라우저·CDN 10분)를 피하려 매번 다른 주소로 받는다
  const res = await fetch(`index.html?_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const m = /app\.js\?v=([0-9a-f]+)/.exec(await res.text());
  return m ? m[1] : null;
}
async function checkForUpdate() {
  if (Date.now() - lastUpdateCheck < UPDATE_MIN_GAP) return;
  lastUpdateCheck = Date.now();
  const found = [];
  try {
    const appHash = await latestAppHash();
    if (appHash && appHash !== runningAppHash()) found.push("앱");
    if (currentUser) {
      const vs = await Promise.all(PKGS.map(pkg => FB.bundleVersion(pkg, "cards")));
      PKGS.forEach((pkg, i) => {
        if (vs[i] && vs[i] !== (FB.cachedBundle(pkg, "cards").v || null)) { FB.dropBundleCache(pkg); if (!found.includes("카드")) found.push("카드"); }
      });
    }
  } catch (e) { console.warn("[update] 확인 실패", e); return; }
  if (!found.length) return;
  updatePending = found.join("·");
  applyUpdateIfIdle();
}
function inQuiz() { return !document.getElementById("screen-quiz").classList.contains("hidden"); }
function applyUpdateIfIdle() {
  if (!updatePending) return;
  if (inQuiz()) {
    document.getElementById("update-text").textContent = `새 ${updatePending} 버전이 있어요 — 세션이 끝나면 적용됩니다`;
    document.getElementById("update-banner").classList.remove("hidden");
    return;
  }
  location.reload();
}

// ===== 기출문제 =====
// exam/index.json: [{id, title, count, questions:[{n, points, text, img}]}]  (tools/extract_exam.py 가 만든다)
let EXAMS = null, exam = null;   // exam = { entry, idx }
async function loadExams() {
  if (EXAMS) return EXAMS;
  const getJson = async url => { const r = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" }); return r.ok ? r.json() : null; };
  let list = [];
  try { list = (await getJson(`exam/${MAJOR}/index.json`)) || []; } catch {}   // 오프라인 등. 서비스 워커 캐시가 있으면 fetch 가 그걸 돌려준다
  // 텍스트판: exam/<전공>/text/index.json = [시험id], 각 exam/<전공>/text/<시험id>.json
  //   { id:"2026A-text", tagId:"2026A", format:"text", title, note, questions:[{n, points, html}] }
  //   이미지판 바로 뒤에 끼워 넣는다. 답안·관련 카드는 tagId(원 시험) 기준.
  try {
    const ids = (await getJson(`exam/${MAJOR}/text/index.json`)) || [];
    const entries = await Promise.all(ids.map(id => getJson(`exam/${MAJOR}/text/${id}.json`).catch(() => null)));
    entries.filter(Boolean).forEach(t => {
      t.format = "text"; t.count = t.questions.length;
      const at = list.findIndex(e => e.id === t.tagId);
      list.splice(at >= 0 ? at + 1 : 0, 0, t);
    });
  } catch {}
  EXAMS = list;
  return EXAMS;
}
const examTag = entry => entry.tagId || entry.id;   // 답안 파일·카드 출처 태그에 쓰는 시험 id
async function renderExamList() {
  const list = await loadExams();
  const box = document.getElementById("exam-list");
  box.innerHTML = list.length
    ? list.map(e => `<div class="exam-item${e.format === "text" ? " exam-item-text" : ""}" data-id="${esc(e.id)}"><b>${esc(e.title)}</b><span>${e.count}문항${e.format === "text" ? " · 글" : ""}</span></div>`).join("")
    : `<p class="hint">등록된 기출문제가 없습니다.</p>`;
  document.getElementById("exam-list-view").classList.remove("hidden");
  document.getElementById("exam-q-view").classList.add("hidden");
}
function openExam(id, idx = 0) {
  const entry = EXAMS.find(e => e.id === id);
  if (!entry) return;
  exam = { entry, idx };
  const nums = document.getElementById("exam-q-nums");
  nums.innerHTML = entry.questions.map((q, i) => `<button type="button" data-i="${i}">${q.n}</button>`).join("");
  document.getElementById("exam-list-view").classList.add("hidden");
  document.getElementById("exam-q-view").classList.remove("hidden");
  renderExamQ();
}
// 참고 답안: exam/answers/<id>.json ({note, answers:{"1":[줄,...]}}). 없으면 버튼을 숨긴다.
const ANSWERS = {};
async function loadAnswers(id) {
  if (id in ANSWERS) return ANSWERS[id];
  try {
    const res = await fetch(`exam/${MAJOR}/answers/${id}.json?_=${Date.now()}`, { cache: "no-store" });
    ANSWERS[id] = res.ok ? await res.json() : null;
  } catch { ANSWERS[id] = null; }
  return ANSWERS[id];
}
function hideAnswer() {
  document.getElementById("exam-answer").classList.add("hidden");
  document.getElementById("btn-exam-answer").textContent = "답 보기";
}
function toggleAnswer() {
  return toggleAnswerBox(exam.entry, exam.entry.questions[exam.idx], document.getElementById("exam-answer"), document.getElementById("btn-exam-answer"));
}
// 참고 답안 상자를 채우거나 닫는다. 기출문제 탭과 학습 중 겹창이 함께 쓴다.
async function toggleAnswerBox(entry, q, box, btn) {
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); btn.textContent = "답 보기"; return; }
  const data = await loadAnswers(examTag(entry));
  const lines = data && data.answers && data.answers[String(q.n)];
  // 이 문항을 출처로 가진 카드들 — 답안 문장 속 표제어는 눌러서 열리게, 아래에는 칩으로 모두 나열
  const tag = `${examTag(entry)}${q.n}`;
  const related = CARDS.filter(c => (c.출처 || "").split(";").some(t => t.trim() === tag))
                       .sort((a, b) => b.표제어.length - a.표제어.length);   // 긴 표제어부터 치환해 부분 겹침을 막는다
  const linkify = text => {
    let html = esc(text);
    related.forEach(c => {
      const name = esc(c.표제어);
      if (!name || html.indexOf(name) < 0) return;
      html = html.split(name).join(`‹‹${name}››`);   // 임시 표시 후 한 번에 버튼으로
    });
    return html.replace(/‹‹(.+?)››/g, (_, n) => `<button type="button" class="link-card ans-link" data-name="${n}">${n}</button>`);
  };
  const chips = related.length
    ? `<div class="ans-related"><span class="hint">관련 카드</span>${related.map(c =>
        `<button type="button" class="link-card chip" data-name="${esc(c.표제어)}">${esc(c.표제어)}</button>`).join("")}</div>`
    : "";
  box.innerHTML = `<p class="ans-note">${esc(data && data.note || "참고 답안")}</p>` +
    (lines ? lines.map(l => `<p>${linkify(l)}</p>`).join("") : `<p class="ans-none">이 문항의 참고 답안은 아직 없습니다.</p>`) + chips;
  box.classList.remove("hidden");
  btn.textContent = "답 닫기";
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderExamQ() {
  const { entry, idx } = exam;
  const q = entry.questions[idx];
  hideAnswer();
  loadAnswers(examTag(entry)).then(d => document.getElementById("btn-exam-answer").classList.toggle("hidden", !(d && d.answers)));
  document.getElementById("exam-progress").textContent = `${entry.title} · ${q.n}번 / ${entry.count}문항${q.points ? ` · ${q.points}점` : ""}`;
  const isText = entry.format === "text";
  const view = document.getElementById("exam-q-view");
  view.querySelector(".zoom-bar").classList.toggle("hidden", isText);
  document.getElementById("exam-q-panel").classList.toggle("hidden", isText);
  const textBox = document.getElementById("exam-q-text");
  textBox.classList.toggle("hidden", !isText);
  if (isText) {
    textBox.innerHTML = q.html + (entry.note && idx === 0 ? `<p class="qx-note">${esc(entry.note)}</p>` : "");
  } else {
    const img = document.getElementById("exam-q-img");
    img.src = q.img; img.alt = `${q.n}번 문항`;
    setZoom("exam-q", 1);
  }
  document.querySelectorAll("#exam-q-nums button").forEach(b => b.classList.toggle("active", +b.dataset.i === idx));
  document.getElementById("btn-exam-prev").disabled = idx === 0;
  document.getElementById("btn-exam-next").disabled = idx === entry.questions.length - 1;
  // 다음 문항을 미리 받아 둔다
  const nx = entry.questions[idx + 1]; if (nx && nx.img) { const pre = new Image(); pre.src = nx.img; }
  window.scrollTo({ top: 0 });
}
function examStep(d) {
  const n = exam.idx + d;
  if (n < 0 || n >= exam.entry.questions.length) return;
  exam.idx = n; renderExamQ();
}

// ===== 내 정보 =====
function renderMe() {
  const stats = loadStats();
  const ids = Object.keys(stats);
  const tries = ids.reduce((a, id) => a + (stats[id].tries || 0), 0);
  const correct = ids.reduce((a, id) => a + (stats[id].correct || 0), 0);
  const mastered = ids.filter(id => (stats[id].box || 0) >= 5).length;
  const wrong = ids.filter(id => stats[id].wrong).length;
  const pct = n => CARDS.length ? Math.round(n / CARDS.length * 100) : 0;
  document.getElementById("me-summary").innerHTML = [
    [`${ids.length.toLocaleString()}장`, `본 카드 (${pct(ids.length)}%)`],
    [`${tries ? Math.round(correct / tries * 100) : 0}%`, `누적 정답률 (${tries.toLocaleString()}회)`],
    [`${mastered.toLocaleString()}장`, `5단계 도달 (${pct(mastered)}%)`],
    [`${wrong.toLocaleString()}장`, `오답 노트`],
  ].map(([v, l]) => `<div class="me-stat"><b>${v}</b><span>${l}</span></div>`).join("");
  document.getElementById("me-app-ver").textContent = appVersion() || "-";
  document.getElementById("me-data-ver").textContent = dataVersion();
  document.getElementById("me-sync").textContent = lastSyncAt ? new Date(lastSyncAt).toLocaleString("ko-KR") : "-";
}

// ===== 설정 =====
function openSettings() { document.getElementById("settings-overlay").classList.remove("hidden"); }
function closeSettings() { document.getElementById("settings-overlay").classList.add("hidden"); }

// ===== 도움말 =====
function openHelp() {
  document.getElementById("help-cards").textContent = CARDS.length ? `${CARDS.length.toLocaleString()}장` : "-";
  document.getElementById("help-app-ver").textContent = appVersion() || "-";
  document.getElementById("help-data-ver").textContent = dataVersion();
  const n = Object.keys(loadStats()).length;
  document.getElementById("help-seen").textContent = CARDS.length ? `${n.toLocaleString()}장 (${Math.round(n / CARDS.length * 100)}%)` : "-";
  closeSettings();
  const el = document.getElementById("help-overlay");
  el.classList.remove("hidden");
  el.querySelector(".peek-box").scrollTop = 0;
}
function closeHelp() { document.getElementById("help-overlay").classList.add("hidden"); }

// ===== 로그인 =====
function setLoginMsg(text, isError) {
  const el = document.getElementById("login-msg");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}
async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const pw = document.getElementById("login-pw").value;
  if (!email || !pw) { setLoginMsg("이메일과 비밀번호를 입력하세요.", true); return; }
  const btn = document.getElementById("btn-login");
  btn.disabled = true; setLoginMsg("로그인 중…");
  try { await FB.login(email, pw); }   // 성공하면 onAuth 콜백이 이어서 진행
  catch (e) { setLoginMsg(FB.authMessage(e), true); }
  finally { btn.disabled = false; }
}
// 전공 전환 칩 (허용 전공이 둘 이상일 때만 설정에 노출)
function buildMajorChips(majors) {
  const box = document.getElementById("major-chips"), wrap = document.getElementById("major-block");
  if (!box) return;
  wrap.classList.toggle("hidden", majors.length < 2);
  box.innerHTML = "";
  majors.forEach(m => {
    const chip = document.createElement("span");
    chip.className = "chip" + (m === MAJOR ? " on" : "");
    chip.textContent = m;
    chip.onclick = () => { if (m === MAJOR) return; try { localStorage.setItem(MAJOR_KEY, m); } catch {} location.reload(); };
    box.appendChild(chip);
  });
}
async function doSignup() {
  const email = document.getElementById("signup-email").value.trim();
  const pw = document.getElementById("signup-pw").value, pw2 = document.getElementById("signup-pw2").value;
  const msg = document.getElementById("signup-msg");
  msg.textContent = "";
  if (!email || !pw) { msg.textContent = "이메일과 비밀번호를 입력하세요."; return; }
  if (pw !== pw2) { msg.textContent = "비밀번호가 서로 다릅니다."; return; }
  const major = document.getElementById("signup-major").value;
  const btn = document.getElementById("btn-signup"); btn.disabled = true;
  try { await FB.signup(email, pw, major); }   // 성공하면 onAuth → 승인 대기 화면
  catch (e) { msg.textContent = FB.authMessage(e); }
  finally { btn.disabled = false; }
}
async function doChangePassword() {
  const cur = document.getElementById("pw-current").value, nw = document.getElementById("pw-new").value, nw2 = document.getElementById("pw-new2").value;
  const msg = document.getElementById("pw-msg"); msg.textContent = "";
  if (!cur || !nw) { msg.textContent = "현재 비밀번호와 새 비밀번호를 입력하세요."; return; }
  if (nw !== nw2) { msg.textContent = "새 비밀번호가 서로 다릅니다."; return; }
  try { await FB.changePassword(cur, nw); ["pw-current", "pw-new", "pw-new2"].forEach(id => document.getElementById(id).value = ""); document.getElementById("pw-form").classList.add("hidden"); alert("비밀번호를 바꿨습니다."); }
  catch (e) { msg.textContent = FB.authMessage(e); }
}
async function doResetPassword() {
  const email = document.getElementById("login-email").value.trim();
  if (!email) { setLoginMsg("재설정 메일을 받을 이메일을 먼저 입력하세요.", true); return; }
  try { await FB.resetPassword(email); setLoginMsg(`${email} 로 재설정 메일을 보냈습니다.`); }
  catch (e) { setLoginMsg(FB.authMessage(e), true); }
}

// 로그인한 사용자의 데이터(카드·관계·기록)를 읽어 학습하기 화면을 연다
let dataLoaded = false;
function pickMajor(majors) {
  let saved = "";
  try { saved = localStorage.getItem(MAJOR_KEY) || ""; } catch {}
  return majors.includes(saved) ? saved : majors[0];
}
function applyTitles() {
  const name = majorConfig().name || "";
  document.title = name ? `${APP_TITLE} · ${name}` : APP_TITLE;
  const badge = document.getElementById("major-badge");
  if (badge) { badge.textContent = name; badge.classList.toggle("hidden", !name); }
}
const STATUS_TEXT = {
  pending: ["승인 대기 중", "관리자가 승인하면 카드 학습을 시작할 수 있습니다. 승인까지 보통 하루 이내입니다."],
  hold:    ["승인 보류", "요청이 보류되었습니다. 문의: rei@readerseye.com"],
  rejected:["승인 거절", "요청이 승인되지 않았습니다. 문의: rei@readerseye.com"],
};
async function showPending() {
  document.getElementById("pending-email").textContent = currentUser ? currentUser.email : "";
  const req = USER && USER.requestedMajor;
  let name = req || "";
  if (req) { const m = (await FB.listMajors()).find(x => x.id === req); if (m) name = m.name; }
  document.getElementById("pending-major").textContent = name ? `[${name}] 전공` : "";
  const [title, note] = STATUS_TEXT[(USER && USER.status) || "pending"] || STATUS_TEXT.pending;
  document.getElementById("pending-title").textContent = title;
  document.getElementById("pending-note").textContent = note;
  show("pending");
}
async function fillMajorSelect() {
  const sel = document.getElementById("signup-major");
  if (sel.options.length) return;
  const list = await FB.listMajors();
  (list.length ? list : [{ id: "art", name: "미술" }]).forEach(m => { const o = document.createElement("option"); o.value = m.id; o.textContent = m.name; sel.appendChild(o); });
}
async function bootUserData() {
  setLoginMsg("권한을 확인하는 중…");
  try { USER = await FB.loadUser(currentUser.uid); }
  catch (e) { console.error(e); setLoginMsg("권한 정보를 읽지 못했습니다: " + (e && e.message || e), true); return; }
  const majors = (USER && USER.majors) || [];
  if (!majors.length) { showPending(); return; }
  MAJOR = pickMajor(majors);
  PKGS = ["common", MAJOR];
  buildMajorChips(majors);
  // 카드 캐시가 있으면 서버를 기다리지 않고 바로 시작한다. 진행 기록 동기화와 새 데이터 확인은 화면을 띄운 뒤 이어서.
  CACHE_FIRST = PKGS.every(pkg => typeof FB.cachedBundle(pkg, "cards").text === "string");
  setLoginMsg(CACHE_FIRST ? "준비 중…" : "카드 데이터를 처음 받는 중… (잠시 걸립니다)");
  try {
    EXAMS = null; exam = null;
    await Promise.all([loadCards().then(loadLinks), loadExams().catch(() => {})]);
    dataLoaded = true;
    if (!CACHE_FIRST) await syncProgress();
  } catch (e) {
    console.error(e);
    setLoginMsg("데이터를 불러오지 못했습니다: " + (e && e.message || e), true);
    return;
  }
  applyTitles();
  buildSubjectChips();
  rebuildDependentChips();     // 유형·시대·태그·중요도 전체 선택 상태로 시작
  updatePoolCount();
  updateWrongCount();
  document.getElementById("login-pw").value = "";
  setLoginMsg("");
  show("setup");
  if (CACHE_FIRST) {
    // 뒤에서: 다른 기기 기록 받기 → 새 카드 데이터가 있으면 캐시를 버리고 새로고침 (학습 중이면 세션 끝난 뒤)
    syncProgress().then(() => { updateWrongCount(); if (!inQuiz()) updatePoolCount(); })
      .then(() => { lastUpdateCheck = 0; return checkForUpdate(); }).catch(e => console.warn("[boot] 배경 동기화 실패", e));
  } else {
    lastUpdateCheck = Date.now();   // 방금 받았으니 잠시 확인하지 않는다
  }
}

async function init() {
  applyFontScale(loadFontScale());   // 저장된 글자 크기를 먼저 반영
  buildFontChips();
  applyTheme(loadTheme());           // 저장된 화면 테마를 반영 (head 인라인 스크립트가 이미 반영했어도 안전하게 재적용)
  buildThemeChips();
  show("login");
  setLoginMsg("로그인 상태 확인 중…");
  document.getElementById("login-ver").textContent = appVersion();

  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".link-card");
    if (b) { e.preventDefault(); openPeek(b.dataset.name); }
  });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".src-link");
    if (b) { e.preventDefault(); openExamPeek(b.dataset.exam, +b.dataset.idx); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closePeek(); closeHelp(); closeSettings();
    const ep = document.getElementById("exam-peek"); if (ep) ep.classList.add("hidden"); } });
  window.addEventListener("message", e => {
    if (e.data && e.data.type === "open-card" && typeof e.data.name === "string") {
      openPeek(e.data.name);
    }
  });
  document.getElementById("btn-settings").onclick = openSettings;
  document.getElementById("btn-settings-close").onclick = closeSettings;
  document.getElementById("settings-overlay").addEventListener("click", e => { if (e.target.id === "settings-overlay") closeSettings(); });
  document.getElementById("nav-me").onclick = () => { renderMe(); show("me"); };
  document.getElementById("nav-exam").onclick = () => { show("exam"); if (!exam) renderExamList(); };
  document.getElementById("exam-list").addEventListener("click", e => {
    const it = e.target.closest(".exam-item"); if (it) openExam(it.dataset.id);
  });
  document.getElementById("exam-q-nums").addEventListener("click", e => {
    const b = e.target.closest("button"); if (b) { exam.idx = +b.dataset.i; renderExamQ(); }
  });
  document.getElementById("btn-exam-back").onclick = () => { exam = null; renderExamList(); };
  document.getElementById("exam-q-nums").insertAdjacentHTML("afterend", zoomBar("exam-q"));
  wireDoubleTap("exam-q");
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-zoom]");
    if (b) stepZoom(b.dataset.for, b.dataset.zoom);
  });
  document.getElementById("btn-exam-answer").onclick = toggleAnswer;
  document.getElementById("btn-exam-prev").onclick = () => examStep(-1);
  document.getElementById("btn-exam-next").onclick = () => examStep(1);
  document.addEventListener("keydown", e => {
    if (!exam || document.getElementById("screen-exam").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") examStep(1); else if (e.key === "ArrowLeft") examStep(-1);
  });
  document.getElementById("btn-resync").onclick = async () => {
    const b = document.getElementById("btn-resync"); b.disabled = true; b.textContent = "동기화 중…";
    try { lastSyncAt = 0; await syncProgress(); } finally { b.disabled = false; b.textContent = "지금 동기화"; renderMe(); updateWrongCount(); }
  };
  document.getElementById("btn-help").onclick = openHelp;
  document.getElementById("btn-help-close").onclick = closeHelp;
  document.getElementById("help-overlay").addEventListener("click", e => { if (e.target.id === "help-overlay") closeHelp(); });

  // 버튼·칩 클릭음 (이벤트 위임 → 이후 추가되는 칩에도 자동 적용)
  document.addEventListener("click", e => {
    if (e.target.closest("button, .chip")) playClick();
  });

  document.getElementById("btn-login").onclick = doLogin;
  document.getElementById("btn-show-signup").onclick = () => { document.getElementById("login-form").classList.add("hidden"); document.getElementById("signup-form").classList.remove("hidden"); fillMajorSelect(); };
  document.getElementById("btn-show-login").onclick = () => { document.getElementById("signup-form").classList.add("hidden"); document.getElementById("login-form").classList.remove("hidden"); };
  document.getElementById("btn-signup").onclick = doSignup;
  document.getElementById("btn-pending-logout").onclick = () => FB.logout();
  document.getElementById("btn-pending-refresh").onclick = () => bootUserData();
  document.getElementById("btn-change-pw").onclick = doChangePassword;
  document.getElementById("btn-toggle-pw").onclick = () => { document.getElementById("pw-form").classList.remove("hidden"); document.getElementById("pw-current").focus(); };
  document.getElementById("btn-cancel-pw").onclick = () => { document.getElementById("pw-form").classList.add("hidden"); document.getElementById("pw-msg").textContent = ""; ["pw-current", "pw-new", "pw-new2"].forEach(id => document.getElementById(id).value = ""); };
  ["login-email", "login-pw"].forEach(id =>
    document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); }));
  document.getElementById("btn-reset-pw").onclick = doResetPassword;
  document.getElementById("btn-logout").onclick = () => {
    const inQuiz = !document.getElementById("screen-quiz").classList.contains("hidden");
    if (inQuiz && !confirm("학습 중입니다. 로그아웃할까요? (채점한 기록은 저장됩니다)")) return;
    FB.logout();
  };

  // 태그 모두 선택 / 해제
  document.getElementById("tag-all").onclick = () => {
    const values = uniqueValues("태그", subjectPool());
    filters.태그 = new Set(values);
    buildChips("filter-tag", "태그", values);
    updatePoolCount();
  };
  document.getElementById("tag-none").onclick = () => {
    filters.태그.clear();
    buildChips("filter-tag", "태그", uniqueValues("태그", subjectPool()));
    updatePoolCount();
  };

  document.querySelectorAll('input[name="mode"]').forEach(r => r.onchange = updatePoolCount);
  document.getElementById("btn-cardlist").onclick = openCardList;
  document.getElementById("btn-start").onclick = startSession;
  document.getElementById("btn-wrongnote").onclick = startReviewSession;
  document.getElementById("btn-reveal").onclick = reveal;
  document.getElementById("btn-hint").onclick = useHint;
  buildReportReasons();
  document.getElementById("btn-report").onclick = () => {
    document.getElementById("report-form").classList.remove("hidden");
    document.getElementById("report-note").focus();
  };
  document.getElementById("btn-report-cancel").onclick = updateReportUI;
  document.getElementById("btn-report-send").onclick = sendReport;
  document.getElementById("btn-correct").onclick = () => judge(true);
  document.getElementById("btn-wrong").onclick = () => judge(false);
  document.getElementById("btn-quit").onclick = () => {
    if (confirm("학습을 중단할까요? (지금까지 채점한 기록은 저장됩니다)")) {
      updateWrongCount(); backFromSession();
    }
  };
  document.getElementById("btn-again").onclick = () => { backFromSession(); updatePoolCount(); updateWrongCount(); };
  document.getElementById("nav-setup").onclick = () => { show("setup"); updatePoolCount(); updateWrongCount(); };
  document.getElementById("nav-stats").onclick = () => { renderStats(); show("stats"); };
  document.getElementById("nav-map").onclick = () => { renderMap(); show("map"); };
  document.getElementById("area-grid").addEventListener("click", e => {
    const b = e.target.closest(".area-cell");
    if (b) startAreaSession(b.dataset.key);
  });
  document.getElementById("btn-reset").onclick = () => {
    if (confirm("모든 학습 기록을 삭제할까요? 모든 기기에서 지워지며 되돌릴 수 없습니다.")) {
      PKGS.forEach(p => { storePkgStats(p, {}); if (currentUser) FB.writeProgress(currentUser.uid, p, {}).catch(e => alert("클라우드 기록 삭제 실패: " + e)); });
      renderMe(); updateWrongCount();
    }
  };

  document.getElementById("btn-update-now").onclick = () => location.reload();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !currentUser) return;
    checkForUpdate();
    const before = JSON.stringify(loadStats());
    await resyncIfStale();
    if (JSON.stringify(loadStats()) === before) return;
    const inQuiz = !document.getElementById("screen-quiz").classList.contains("hidden");
    if (inQuiz) return;   // 진행 중인 세션은 건드리지 않는다
    updateWrongCount(); updatePoolCount();
    if (!document.getElementById("screen-stats").classList.contains("hidden")) renderStats();
    if (!document.getElementById("screen-map").classList.contains("hidden")) renderMap();
  });

  FB.onAuth(user => {
    currentUser = user;
    if (user) {
      document.getElementById("user-email").textContent = user.email || "";
      bootUserData();
    } else {
      session = null; USER = null; MAJOR = ""; PKGS = []; CARDS = [];
      document.getElementById("user-email").textContent = "";
      applyTitles();
      setLoginMsg("");
      show("login");
    }
  });
}

// 모듈 스코프라 콘솔·자동 테스트에서 상태를 볼 수 없어 읽기 전용 핸들을 둔다
window.__app = { get CARDS() { return CARDS; }, get session() { return session; }, get user() { return currentUser; }, get major() { return MAJOR; }, set major(v) { MAJOR = v; }, get config() { return CONFIG; }, loadStats, loadExams, openExam, openExamPeek, show };

if ("serviceWorker" in navigator) {
  // 오프라인에서도 앱 껍데기가 뜨도록. 등록 실패는 무시한다(파일 프로토콜, 사설 모드 등)
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

init();
