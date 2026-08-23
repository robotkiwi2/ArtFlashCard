"use strict";

// ===== 상태 =====
let CARDS = [];                 // 전체 카드
let selectedSubject = "";       // "" = 전체 과목 (단일 선택)
let filters = { 유형: new Set(), 시대: new Set(), 태그: new Set(), 중요도: new Set() };
let session = null;             // { queue, idx, mode, correct, wrongCards }

const LS_KEY = "flashcard-stats-v1";
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

// 출제 가중치: 미학습 > 오답 > 맞힌 지 얼마 안 된 카드 순으로 높다.
function cardWeight(c, stats) {
  const s = stats[c.id];
  if (!s) return 8;                                   // 아직 안 본 카드 최우선
  let w = 8 / Math.pow(2, Math.min(s.box || 0, 5));   // 연속 정답마다 절반씩 감소
  if (s.wrong) w *= 2;                                // 오답 상태면 두 배
  const days = s.last
    ? Math.max(0, (Date.now() - new Date(s.last).getTime()) / 86400000)
    : 0;
  w *= 1 + Math.min(days, 30) / 15;                   // 오래 방치될수록 최대 3배까지 회복
  return w;
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

function renderCard() {
  const c = session.queue[session.idx];
  const front = document.getElementById("card-front");
  const back = document.getElementById("card-back");
  const meta = `<div class="meta">${c.과목} · ${c.유형}${c.시대 ? " · " + c.시대 : ""} · 중요도 ${c.중요도}</div>`;

  if (session.mode === "term") {
    front.innerHTML = termTag(c) + meta;
    back.innerHTML = `<div class="desc">${c.설명}</div>` + imgTag(c);
  } else if (session.mode === "desc") {
    front.innerHTML = `<div class="desc">${c.설명}</div>` + meta;
    back.innerHTML = termTag(c) + imgTag(c);
  } else { // image
    front.innerHTML = imgTag(c) + meta;
    back.innerHTML = termTag(c) + `<div class="desc">${c.설명}</div>`;
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

function renderStats() {
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
  await loadCards();
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
