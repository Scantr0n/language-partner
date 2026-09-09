const LANGS = {
  zh: {
    label: '中文 Mandarin',
    voice: 'alloy',
    levels: [
      { id: 'hsk4', label: 'HSK4 (current focus)' },
      { id: 'hsk3', label: 'HSK3 (easier)' },
      { id: 'hsk5', label: 'HSK5 (harder)' },
    ],
    instructions: (level) => `You are a warm, patient Mandarin Chinese conversation partner for a learner studying toward ${level.toUpperCase()}.
Speak primarily in Mandarin at a pace and vocabulary level appropriate for ${level.toUpperCase()}. Favor vocabulary and grammar patterns typical of ${level.toUpperCase()} textbooks (like HSK Standard Course).
Keep the conversation flowing naturally with real back-and-forth — ask follow-up questions, react to what they say, don't just quiz them.
When the learner makes a grammar or word-choice mistake, briefly and gently correct it in Mandarin (repeat the corrected phrase), then continue the conversation naturally — don't lecture.
If they seem stuck or ask for help, you can briefly clarify in English, then return to Mandarin.
Try to naturally work in HSK4-level vocabulary (topics like work, relationships, society, opinions, environment, technology) so it reinforces what they're studying.`,
    showHsk: true,
  },
  ja: {
    label: '日本語 Japanese',
    voice: 'alloy',
    levels: [
      { id: 'n5-n4', label: 'Beginner (N5–N4)' },
      { id: 'n3', label: 'Intermediate (N3)' },
      { id: 'n2-n1', label: 'Advanced (N2–N1)' },
    ],
    instructions: (level) => `You are a warm, patient Japanese conversation partner for a learner at roughly the ${level.toUpperCase()} level.
Speak primarily in Japanese at a pace and vocabulary/grammar level appropriate for ${level.toUpperCase()}.
Keep the conversation flowing naturally with real back-and-forth — ask follow-up questions, react to what they say, don't just quiz them.
The learner enjoys anime, so casual topics related to anime, shows, hobbies, and daily life are great conversation starters, but follow their lead on topic.
When the learner makes a grammar or word-choice mistake, briefly and gently correct it in Japanese (repeat the corrected phrase), then continue the conversation naturally — don't lecture.
If they seem stuck or ask for help, you can briefly clarify in English, then return to Japanese.`,
    showHsk: false,
  },
};

let currentLang = 'zh';
let pc = null;
let dc = null;
let micStream = null;

const langButtons = document.querySelectorAll('.lang-btn');
const levelSelect = document.getElementById('level');
const connectBtn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const remoteAudio = document.getElementById('remoteAudio');
const mainTabs = document.getElementById('mainTabs');
const tabButtons = document.querySelectorAll('.tab-btn');
const talkView = document.getElementById('talkView');
const planView = document.getElementById('planView');

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function populateLevels() {
  const lang = LANGS[currentLang];
  levelSelect.innerHTML = '';
  lang.levels.forEach((lvl) => {
    const opt = document.createElement('option');
    opt.value = lvl.id;
    opt.textContent = lvl.label;
    levelSelect.appendChild(opt);
  });
}

function setTab(tab) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  talkView.classList.toggle('hidden', tab !== 'talk');
  planView.classList.toggle('hidden', tab !== 'plan');
}

tabButtons.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

function setLang(lang) {
  currentLang = lang;
  langButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.lang === lang));
  populateLevels();
  const showPlan = LANGS[lang].showHsk;
  mainTabs.classList.toggle('hidden', !showPlan);
  setTab('talk');
}

langButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (pc) disconnect();
    setLang(btn.dataset.lang);
  });
});

function addMessage(role, text) {
  if (!text) return;
  const hint = transcriptEl.querySelector('.hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function connect() {
  statusEl.textContent = 'Requesting session...';
  const lang = LANGS[currentLang];
  const level = levelSelect.value;

  let instructions = lang.instructions(level);
  if (currentLang === 'zh') {
    const curUnit = currentUnitIndex();
    const title = unitTitles[curUnit] || `Unit ${curUnit + 1}`;
    instructions += `\n\nThe learner is currently working on Unit ${curUnit + 1} (${title}) of their HSK Standard Course 4A textbook. Where natural, steer practice toward that unit's territory.`;
    if (unitFlags[curUnit]) {
      instructions += ` They've flagged this unit as needing extra help — slow down and give it more focus than usual.`;
    }
  }

  let sessionData;
  try {
    const resp = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions, voice: lang.voice }),
    });
    sessionData = await resp.json();
    if (!resp.ok) throw new Error(sessionData.error || 'Failed to create session');
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    return;
  }

  const ephemeralKey = sessionData.value;
  if (!ephemeralKey) {
    statusEl.textContent = 'Error: no session token returned';
    return;
  }

  statusEl.textContent = 'Connecting...';

  pc = new RTCPeerConnection();

  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
  };

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusEl.textContent = 'Microphone access denied';
    pc.close();
    pc = null;
    return;
  }
  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

  dc = pc.createDataChannel('oai-events');
  dc.addEventListener('message', handleServerEvent);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp',
    },
  });

  if (!sdpResp.ok) {
    statusEl.textContent = 'Error: failed to connect to OpenAI';
    pc.close();
    pc = null;
    return;
  }

  const answer = { type: 'answer', sdp: await sdpResp.text() };
  await pc.setRemoteDescription(answer);

  statusEl.textContent = `Connected — speak in ${lang.label}`;
  connectBtn.textContent = 'End conversation';
  connectBtn.classList.add('connected');
}

function handleServerEvent(e) {
  let event;
  try {
    event = JSON.parse(e.data);
  } catch {
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    addMessage('user', event.transcript);
  }
  if (event.type === 'response.output_audio_transcript.done') {
    addMessage('assistant', event.transcript);
  }
}

function disconnect() {
  if (dc) dc.close();
  if (pc) pc.close();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  pc = null;
  dc = null;
  micStream = null;
  statusEl.textContent = 'Not connected';
  connectBtn.textContent = 'Start conversation';
  connectBtn.classList.remove('connected');
}

connectBtn.addEventListener('click', () => {
  if (pc) {
    disconnect();
  } else {
    connect();
  }
});

// --- Quick word lookup ---

const askForm = document.getElementById('askForm');
const askInput = document.getElementById('askInput');
const askResults = document.getElementById('askResults');

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = askInput.value.trim();
  if (!question) return;
  askInput.value = '';
  askInput.disabled = true;

  const qDiv = document.createElement('div');
  qDiv.className = 'ask-q';
  qDiv.textContent = question;
  askResults.appendChild(qDiv);

  const aDiv = document.createElement('div');
  aDiv.className = 'ask-a';
  aDiv.textContent = 'Thinking...';
  askResults.appendChild(aDiv);
  askResults.scrollTop = askResults.scrollHeight;

  try {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, language: currentLang }),
    });
    const data = await resp.json();
    aDiv.textContent = resp.ok ? data.answer : `Error: ${data.error}`;
  } catch (err) {
    aDiv.textContent = `Error: ${err.message}`;
  } finally {
    askInput.disabled = false;
    askInput.focus();
    askResults.scrollTop = askResults.scrollHeight;
  }
});

// --- HSK4 vocab tracker ---

const HSK_STORAGE_KEY = 'languagePartner.hsk4.learned';
const CUSTOM_VOCAB_KEY = 'languagePartner.hsk4.custom';
let hskWords = [];
let learnedSet = new Set();

function loadLearned() {
  try {
    const raw = localStorage.getItem(HSK_STORAGE_KEY);
    if (raw) learnedSet = new Set(JSON.parse(raw));
  } catch {
    learnedSet = new Set();
  }
}

function saveLearned() {
  localStorage.setItem(HSK_STORAGE_KEY, JSON.stringify([...learnedSet]));
}

function renderHskList() {
  const list = document.getElementById('hskList');
  const search = document.getElementById('hskSearch').value.trim().toLowerCase();
  const hideLearned = document.getElementById('hideLearned').checked;

  list.innerHTML = '';
  hskWords
    .filter((w) => {
      if (hideLearned && learnedSet.has(w.hanzi)) return false;
      if (!search) return true;
      return (
        w.hanzi.includes(search) ||
        w.pinyin.toLowerCase().includes(search) ||
        w.english.toLowerCase().includes(search)
      );
    })
    .forEach((w) => {
      const li = document.createElement('li');
      li.className = 'hsk-item' + (learnedSet.has(w.hanzi) ? ' learned' : '');
      li.innerHTML = `
        <input type="checkbox" ${learnedSet.has(w.hanzi) ? 'checked' : ''} data-hanzi="${w.hanzi}" />
        <span class="hanzi">${w.hanzi}</span>
        <span class="pinyin">${w.pinyin}</span>
        <span class="english">${w.english}</span>
      `;
      list.appendChild(li);
    });

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const hanzi = cb.dataset.hanzi;
      if (cb.checked) learnedSet.add(hanzi);
      else learnedSet.delete(hanzi);
      saveLearned();
      renderHskList();
      updateHskProgress();
    });
  });
}

function updateHskProgress() {
  const total = hskWords.length;
  const learned = hskWords.filter((w) => learnedSet.has(w.hanzi)).length;
  document.getElementById('hskProgressText').textContent = `${learned} / ${total} learned`;
  const pct = total ? (learned / total) * 100 : 0;
  document.getElementById('hskProgressFill').style.width = `${pct}%`;
  renderDashboard();
}

function loadCustomWords() {
  return loadJSON(CUSTOM_VOCAB_KEY, []);
}

const addWordForm = document.getElementById('addWordForm');
addWordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const hanzi = document.getElementById('newHanzi').value.trim();
  const pinyin = document.getElementById('newPinyin').value.trim();
  const english = document.getElementById('newEnglish').value.trim();
  if (!hanzi || !english) return;
  const custom = loadCustomWords();
  custom.push({ hanzi, pinyin, english });
  saveJSON(CUSTOM_VOCAB_KEY, custom);
  hskWords.push({ hanzi, pinyin, english });
  document.getElementById('newHanzi').value = '';
  document.getElementById('newPinyin').value = '';
  document.getElementById('newEnglish').value = '';
  renderHskList();
  updateHskProgress();
});

async function loadHskData() {
  const resp = await fetch('data/hsk4-vocab.json');
  const base = await resp.json();
  hskWords = [...base, ...loadCustomWords()];
  loadLearned();
  renderHskList();
  updateHskProgress();
}

document.getElementById('hskSearch').addEventListener('input', renderHskList);
document.getElementById('hideLearned').addEventListener('change', renderHskList);

// --- Study plan / syllabus (HSK Standard Course 4A, 10 units) ---
// Paced against the real Dec 12, 2026 HSK4 test date (Yinghua Academy), using the
// same checkpoint schedule as the dedicated HSK4 tracker session (Trackers/HSK4_Tracker.md)
// — keep these two in sync if the pace ever changes again.

const UNIT_COUNT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function mkDate(y, m, d) {
  return new Date(y, m - 1, d);
}

const SYLLABUS_START = mkDate(2026, 8, 19);
const TEST_DATE = mkDate(2026, 12, 12); // real HSK4 exam date, confirmed via Yinghua Academy

// [unitStart, unitEnd] windows, derived from the checkpoints below.
const UNIT_WINDOWS = [
  [mkDate(2026, 8, 19), mkDate(2026, 9, 6)],
  [mkDate(2026, 9, 6), mkDate(2026, 9, 16)],
  [mkDate(2026, 9, 16), mkDate(2026, 9, 27)],
  [mkDate(2026, 9, 27), mkDate(2026, 10, 7)],
  [mkDate(2026, 10, 7), mkDate(2026, 10, 18)],
  [mkDate(2026, 10, 18), mkDate(2026, 10, 29)],
  [mkDate(2026, 10, 29), mkDate(2026, 11, 8)],
  [mkDate(2026, 11, 8), mkDate(2026, 11, 15)],
  [mkDate(2026, 11, 15), mkDate(2026, 11, 22)],
  [mkDate(2026, 11, 22), mkDate(2026, 11, 29)],
];

// Cumulative-units-expected checkpoints — mirrors Trackers/HSK4_Tracker.md exactly.
// A verdict (on track/behind) is only ever shown ON these dates, per Jack's standing
// rule to never render a judgment call on a random day.
const CHECKPOINTS = [
  { date: mkDate(2026, 9, 6), units: 1 },
  { date: mkDate(2026, 9, 27), units: 3 },
  { date: mkDate(2026, 10, 18), units: 5 },
  { date: mkDate(2026, 11, 8), units: 7 },
  { date: mkDate(2026, 11, 29), units: 10 },
];

const SESSION_OFFSETS = [0.15, 0.5, 0.85]; // spread the 3 sessions across each unit's window

const UNIT_DAY_TEMPLATE = [
  {
    items: [
      { key: 'warmup', label: '热身 Warm-up — vocab matching + topic check' },
      { key: 'text1', label: '课文一 Text 1 — read + new words' },
    ],
  },
  {
    items: [
      { key: 'text2', label: '课文二 Text 2 — read + new words' },
      { key: 'text3', label: '课文三 Text 3 — read + new words' },
    ],
  },
  {
    items: [
      { key: 'grammar', label: '语法 Grammar points + drills' },
      { key: 'exercises', label: '练习 Exercises + group work' },
      { key: 'quiz', label: 'Self-quiz — unit vocab + grammar' },
    ],
  },
];

const REVIEW_DAY_ITEMS = [
  { key: 'mocktest', label: 'Full mock listening + reading practice' },
  { key: 'finalreview', label: 'Review flagged units + weak vocab' },
];

const DEFAULT_UNIT_TITLES = ['简单爱 · Simple Love', '', '', '', '', '', '', '', '', ''];

function buildSchedule() {
  const units = UNIT_WINDOWS.map(([start, end], u) => {
    const spanMs = end.getTime() - start.getTime();
    const days = UNIT_DAY_TEMPLATE.map((tmpl, di) => {
      const date = new Date(start.getTime() + spanMs * SESSION_OFFSETS[di]);
      const dayInUnit = di + 1;
      return {
        date,
        unitIndex: u,
        dayInUnit,
        items: tmpl.items.map((it) => ({ ...it, unitIndex: u, dayInUnit })),
      };
    });
    return { index: u, days };
  });
  const reviewDay = {
    date: TEST_DATE,
    unitIndex: -1,
    dayInUnit: 'review',
    items: REVIEW_DAY_ITEMS.map((it) => ({ ...it, unitIndex: -1, dayInUnit: 'review' })),
  };
  return { units, reviewDay };
}

const SCHEDULE = buildSchedule();

const PROGRESS_KEY = 'languagePartner.syllabus.progress';
const TITLES_KEY = 'languagePartner.syllabus.titles';
const FLAGS_KEY = 'languagePartner.syllabus.flags';

let progress = loadJSON(PROGRESS_KEY, {});
let unitTitles = loadJSON(TITLES_KEY, DEFAULT_UNIT_TITLES.slice());
let unitFlags = loadJSON(FLAGS_KEY, new Array(UNIT_COUNT).fill(false));

function itemKey(unitIndex, dayInUnit, key) {
  return `u${unitIndex}-d${dayInUnit}-${key}`;
}

function isItemDone(unitIndex, dayInUnit, key) {
  return !!progress[itemKey(unitIndex, dayInUnit, key)];
}

function toggleItem(unitIndex, dayInUnit, key) {
  const k = itemKey(unitIndex, dayInUnit, key);
  progress[k] = !progress[k];
  saveJSON(PROGRESS_KEY, progress);
}

function allDays() {
  const days = SCHEDULE.units.flatMap((u) => u.days);
  return [...days, SCHEDULE.reviewDay];
}

function allItems() {
  return allDays().flatMap((d) => d.items);
}

function completedCount() {
  return allItems().filter((it) => isItemDone(it.unitIndex, it.dayInUnit, it.key)).length;
}

function completedUnitsCount() {
  return SCHEDULE.units.filter((u) => u.days.every((d) => d.items.every((it) => isItemDone(it.unitIndex, it.dayInUnit, it.key)))).length;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function nextCheckpoint(today) {
  return CHECKPOINTS.find((c) => c.date >= today) || null;
}

function currentUnitIndex() {
  for (const u of SCHEDULE.units) {
    const done = u.days.every((d) => d.items.every((it) => isItemDone(it.unitIndex, it.dayInUnit, it.key)));
    if (!done) return u.index;
  }
  return UNIT_COUNT - 1;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderDashboard() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const total = allItems().length;
  const done = completedCount();
  const daysLeft = Math.max(0, Math.ceil((TEST_DATE - today) / DAY_MS));

  let statusText;
  let statusClass;
  if (today < SYLLABUS_START) {
    statusText = `Starts ${fmtDate(SYLLABUS_START)}`;
    statusClass = 'status-upcoming';
  } else {
    const checkpointToday = CHECKPOINTS.find((c) => isSameDay(c.date, today));
    if (checkpointToday) {
      // Grace policy: on track if at or within 1 full unit of the target (or ahead).
      const completedUnits = completedUnitsCount();
      if (completedUnits >= checkpointToday.units) {
        statusText = `Checkpoint: ahead (${completedUnits}/${checkpointToday.units} units)`;
        statusClass = 'status-ahead';
      } else if (completedUnits >= checkpointToday.units - 1) {
        statusText = `Checkpoint: on track (${completedUnits}/${checkpointToday.units} units)`;
        statusClass = 'status-ontrack';
      } else {
        statusText = `Checkpoint: behind (${completedUnits}/${checkpointToday.units} units)`;
        statusClass = 'status-behind';
      }
    } else {
      // No verdict outside checkpoint dates — just report where the next one is.
      const next = nextCheckpoint(today);
      statusText = next ? `Next checkpoint ${fmtDate(next.date)}` : 'Review window — test Dec 12';
      statusClass = 'status-upcoming';
    }
  }

  const vocabPct = hskWords.length ? (learnedSet.size / hskWords.length) * 100 : 0;
  const progressPct = total ? (done / total) * 100 : 0;
  const readiness = Math.round(0.5 * vocabPct + 0.5 * progressPct);

  const curUnit = currentUnitIndex();
  const curTitle = unitTitles[curUnit] || `Unit ${curUnit + 1}`;

  document.getElementById('dashDaysLeft').textContent = daysLeft;
  const statusEl2 = document.getElementById('dashStatus');
  statusEl2.textContent = statusText;
  statusEl2.className = `stat-value ${statusClass}`;
  document.getElementById('dashProgress').textContent = `${done} / ${total}`;
  document.getElementById('dashReadiness').textContent = `${readiness}%`;
  document.getElementById('dashCurrentUnit').textContent = `Unit ${curUnit + 1}: ${curTitle}${unitFlags[curUnit] ? ' 🚩' : ''}`;
}

function buildDayRow(day) {
  const dayRow = document.createElement('div');
  dayRow.className = 'schedule-day';

  const dateLabel = document.createElement('span');
  dateLabel.className = 'day-date';
  dateLabel.textContent = fmtDate(day.date);
  dayRow.appendChild(dateLabel);

  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'day-items';
  day.items.forEach((it) => {
    const label = document.createElement('label');
    label.className = 'day-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isItemDone(it.unitIndex, it.dayInUnit, it.key);
    cb.addEventListener('change', () => {
      toggleItem(it.unitIndex, it.dayInUnit, it.key);
      renderDashboard();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(it.label));
    itemsWrap.appendChild(label);
  });
  dayRow.appendChild(itemsWrap);
  return dayRow;
}

function renderSchedule() {
  const container = document.getElementById('scheduleList');
  container.innerHTML = '';

  SCHEDULE.units.forEach((u) => {
    const card = document.createElement('div');
    card.className = 'schedule-unit';

    const header = document.createElement('div');
    header.className = 'unit-header';

    const label = document.createElement('span');
    label.className = 'unit-label';
    label.textContent = `Unit ${u.index + 1}`;
    header.appendChild(label);

    const titleInput = document.createElement('input');
    titleInput.className = 'unit-title-input';
    titleInput.placeholder = `Add topic once you get there`;
    titleInput.value = unitTitles[u.index] || '';
    titleInput.addEventListener('change', () => {
      unitTitles[u.index] = titleInput.value;
      saveJSON(TITLES_KEY, unitTitles);
      renderDashboard();
    });
    header.appendChild(titleInput);

    const flagBtn = document.createElement('button');
    flagBtn.type = 'button';
    flagBtn.className = 'flag-btn' + (unitFlags[u.index] ? ' flagged' : '');
    flagBtn.textContent = unitFlags[u.index] ? '🚩 Flagged for help' : '🏳️ Flag for help';
    flagBtn.addEventListener('click', () => {
      unitFlags[u.index] = !unitFlags[u.index];
      saveJSON(FLAGS_KEY, unitFlags);
      renderSchedule();
      renderDashboard();
    });
    header.appendChild(flagBtn);

    card.appendChild(header);
    u.days.forEach((day) => card.appendChild(buildDayRow(day)));
    container.appendChild(card);
  });

  const reviewCard = document.createElement('div');
  reviewCard.className = 'schedule-unit review-card';
  const reviewHeader = document.createElement('div');
  reviewHeader.className = 'unit-header';
  reviewHeader.innerHTML = `<span class="unit-label">Final Review &amp; Test Day</span>`;
  reviewCard.appendChild(reviewHeader);
  reviewCard.appendChild(buildDayRow(SCHEDULE.reviewDay));
  container.appendChild(reviewCard);
}

// --- init ---
setLang('zh');
renderSchedule();
renderDashboard();
loadHskData().then(renderDashboard);
