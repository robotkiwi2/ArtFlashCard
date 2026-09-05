"use strict";

// ===== 상태 =====
let CARDS = [];                 // 전체 카드
let LINKS = new Map();          // 표제어 → 관계 목록 (data/links.csv)
let selectedSubject = "";       // "" = 전체 과목 (단일 선택)
let filters = { 유형: new Set(), 시대: new Set(), 태그: new Set(), 중요도: new Set() };
let session = null;             // { queue, idx, mode, correct, wrongCards }

const LS_KEY = "flashcard-stats-v1";
const FS_KEY = "flashcard-fontsize-v1";
const FONT_SIZES = [
  { label: "작게",    scale: 1.0 },
  { label: "보통",    scale: 1.2 },   // 기본값
  { label: "크게",    scale: 1.45 },
  { label: "아주 크게", scale: 1.75 },
];
const FS_DEFAULT = 1.2;
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

async function loadCards() {
  const res = await fetch("data/cards.csv");
  const text = await res.text();
  const rows = parseCSV(text);
  const header = rows[0];
  CARDS = rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => o[h.trim()] = (r[i] || "").trim());
    o.태그목록 = o.태그 ? o.태그.split(";").map(t => t.trim()).filter(Boolean) : [];
    return o;
  });
}

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
  let text;
  try {
    const res = await fetch("data/links.csv");
    if (!res.ok) return;
    text = await res.text();
  } catch { return; }

  const rows = parseCSV(text);
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

// ===== 학습 기록 (localStorage) =====
function loadStats() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
// box = 연속 정답 횟수(0~5). 맞히면 오르고 틀리면 0으로 초기화된다.
// wrong = 오답 노트 수록 여부. 틀리면 true·맞히면 false.
function saveResult(cardId, isCorrect) {
  const stats = loadStats();
  const s = stats[cardId] || { tries: 0, correct: 0, box: 0 };
  s.tries++;
  if (isCorrect) {
    s.correct++;
    s.box = Math.min((s.box || 0) + 1, 5);
    s.wrong = false;
  } else {
    s.box = 0;
    s.wrong = true;
  }
  s.last = new Date().toISOString().slice(0, 10);
  stats[cardId] = s;
  try { localStorage.setItem(LS_KEY, JSON.stringify(stats)); } catch {}
}

function wrongCards() {
  const stats = loadStats();
  return CARDS.filter(c => stats[c.id] && stats[c.id].wrong);
}

// 출제 가중치. 우선순위는 안 본 카드 > 오답 > 맞힌 카드 순이다.
// 안 본 카드가 남아 있는 동안에는 그쪽이 확실히 먼저 나오도록 기본값을 크게 벌려 두었다.
// (예전에는 안 본 카드가 8 고정인데 맞힌 카드가 방치 보정으로 12까지 올라가
//  안 본 카드를 앞지르는 일이 있었다.)
// 오답만 몰아서 풀고 싶을 때는 '오답 노트' 모드가 따로 있다.
const W_NEW      = 60;   // 아직 안 본 카드
const W_WRONG    = 18;   // 마지막에 틀린 카드
const W_SEEN     = 6;    // 맞힌 카드의 출발점 (연속 정답마다 절반으로 줄어든다)
const W_SEEN_CAP = 12;   // 오래 묵어도 안 본 카드를 앞지르지 못하게 하는 상한

function cardWeight(c, stats) {
  const s = stats[c.id];
  if (!s) return W_NEW;                               // 안 본 카드 최우선
  const days = s.last
    ? Math.max(0, (Date.now() - new Date(s.last).getTime()) / 86400000)
    : 0;
  const rest = 1 + Math.min(days, 30) / 15;           // 방치될수록 최대 3배까지 회복
  if (s.wrong) return W_WRONG * rest;                 // 오답은 그다음
  const w = W_SEEN / Math.pow(2, Math.min(s.box || 0, 5)) * rest;
  return Math.min(w, W_SEEN_CAP);                     // 맞힌 카드는 뒤로
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
    filters[key] = new Set(values);   // 디폴트 전체 선택
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

function updatePoolCount() {
  const n = filteredPool().length;
  const el = document.getElementById("pool-count");
  el.textContent = `선택 범위 카드: ${n}장`;
  el.classList.toggle("zero", n === 0);
  document.getElementById("mode-note").textContent =
    getMode() === "image" ? "(이미지 있는 카드만 대상)" : "";
}

// ===== 화면 전환 =====
const screens = ["setup", "quiz", "result", "stats"];
function show(name) {
  screens.forEach(s => document.getElementById("screen-" + s).classList.toggle("hidden", s !== name));
  // 학습 수행 중에는 상단 네비게이션을 감춘다 (중단해야 노출)
  document.querySelector("header nav").classList.toggle("hidden", name === "quiz");
  document.getElementById("nav-setup").classList.toggle("active", name !== "stats");
  document.getElementById("nav-stats").classList.toggle("active", name === "stats");
}

// ===== 학습 세션 =====
function sessionSize(poolLen) {
  return Math.min(parseInt(document.getElementById("session-count").value, 10) || 10, poolLen);
}

function startSession() {
  const pool = filteredPool();
  if (!pool.length) { alert("선택한 범위에 카드가 없습니다."); return; }
  session = {
    queue: weightedSample(pool, sessionSize(pool.length)),
    idx: 0, mode: getMode(), correct: 0, wrongCards: [], isReview: false,
  };
  show("quiz");
  renderCard();
}

// 오답 노트: 필터 범위를 무시하고 오답으로 기록된 카드만 출제
function startReviewSession() {
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
function srcTag(c) {
  const s = (c.출처 || "").split(";").map(x => x.trim()).filter(Boolean);
  return s.length ? `<div class="src">기출 ${s.length}회 · ${s.join(", ")}</div>` : "";
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

  if (session.mode === "term") {
    front.innerHTML = termTag(c) + metaFront;
    back.innerHTML = capTag(c) + axisHtml(ax) + imgTag(c) + extra;
  } else if (session.mode === "desc") {
    // 첫 축만 제시하고 표제어를 인출한다. 나머지 축은 답과 함께 공개.
    front.innerHTML = axisHtml(ax.slice(0, 1)) + metaFront;
    back.innerHTML = termTag(c) + capTag(c) + axisHtml(ax.slice(1)) + imgTag(c) + extra;
  } else { // image
    // 도판(+캡션)을 주고 기법·사조 등 특징을 인출한다.
    front.innerHTML = imgTag(c) + capTag(c) + metaFront;
    back.innerHTML = termTag(c) + axisHtml(ax) + extra;
  }
  back.classList.add("hidden");
  document.getElementById("btn-reveal").classList.remove("hidden");
  document.getElementById("judge-buttons").classList.add("hidden");
  document.getElementById("quiz-progress").textContent =
    `${session.isReview ? "오답 노트 · " : ""}${session.idx + 1} / ${session.queue.length}`;
}

function reveal() {
  document.getElementById("card-back").classList.remove("hidden");
  document.getElementById("btn-reveal").classList.add("hidden");
  document.getElementById("judge-buttons").classList.remove("hidden");
}

function judge(isCorrect) {
  const c = session.queue[session.idx];
  saveResult(c.id, isCorrect);
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

function renderOverview() {
  const stats = loadStats();
  const total = CARDS.length;
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
    nums +
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

// ===== 초기화 =====
async function init() {
  applyFontScale(loadFontScale());   // 저장된 글자 크기를 먼저 반영
  buildFontChips();
  await loadCards();
  await loadLinks();
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".link-card");
    if (b) { e.preventDefault(); openPeek(b.dataset.name); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePeek(); });
  buildSubjectChips();
  rebuildDependentChips();     // 유형·시대·태그·중요도 전체 선택 상태로 시작
  updatePoolCount();

  // 버튼·칩 클릭음 (이벤트 위임 → 이후 추가되는 칩에도 자동 적용)
  document.addEventListener("click", e => {
    if (e.target.closest("button, .chip")) playClick();
  });

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
  document.getElementById("btn-start").onclick = startSession;
  document.getElementById("btn-wrongnote").onclick = startReviewSession;
  document.getElementById("btn-reveal").onclick = reveal;
  document.getElementById("btn-correct").onclick = () => judge(true);
  document.getElementById("btn-wrong").onclick = () => judge(false);
  document.getElementById("btn-quit").onclick = () => {
    if (confirm("학습을 중단할까요? (지금까지 채점한 기록은 저장됩니다)")) {
      updateWrongCount(); show("setup");
    }
  };
  document.getElementById("btn-again").onclick = () => { show("setup"); updatePoolCount(); updateWrongCount(); };
  document.getElementById("nav-setup").onclick = () => { show("setup"); updatePoolCount(); updateWrongCount(); };
  document.getElementById("nav-stats").onclick = () => { renderStats(); show("stats"); };
  document.getElementById("btn-reset").onclick = () => {
    if (confirm("모든 학습 기록을 삭제할까요? 되돌릴 수 없습니다.")) {
      localStorage.removeItem(LS_KEY);
      renderStats(); updateWrongCount();
    }
  };
  updateWrongCount();
}

init();
