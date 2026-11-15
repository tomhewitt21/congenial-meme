// Word Club front end. Plain JavaScript, no build step.

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $overlay = document.getElementById('overlay');
const $live = document.getElementById('live');

// ---------------------------------------------------------------- storage
const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  token: store.get('wc_token'),
  me: null,
  config: null,
  today: null,       // { date, words, streak }
  selected: 0,       // which of today's words is showing
  replyTo: null,     // { id, name }
  poll: null,
};

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (name) => esc((name || '?').trim().charAt(0) || '?');
const avatar = (u, size = '') => `<span class="avatar ${size}" style="background:${esc(u.color)}" aria-hidden="true">${initial(u.name)}</span>`;

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) store.set('wc_family_code', urlCode);

const ICON = {
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  bookmarkFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h8M8 11h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>',
  plusBox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  chevronLeft: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
};

const REACTIONS = [
  { kind: 'knew', label: 'Knew it' },
  { kind: 'new', label: 'New to me' },
  { kind: 'love', label: 'Love it' },
  { kind: 'use', label: 'Will use' },
];

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && state.token) {
    state.token = null; state.me = null; store.del('wc_token');
    go('#/join');
  }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
  return data;
}

function fmtDay(day, { long = false } = {}) {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', long
    ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }
    : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function fmtWhen(iso) {
  const t = new Date(iso);
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  const sameDay = t.toDateString() === new Date().toDateString();
  const time = t.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '');
  if (sameDay) return time;
  return `${t.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function stopPolling() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

// ---------------------------------------------------------------- tab bar
function renderTabs(active) {
  if (!active) { $tabs.innerHTML = ''; return; }
  const tab = (id, href, icon, label) =>
    `<a href="${href}" ${active === id ? 'aria-current="page"' : ''}>${icon}${label}</a>`;
  $tabs.innerHTML = `<div class="tabbar"><nav aria-label="Main">
    ${tab('today', '#/', ICON.sun, 'Today')}
    ${tab('archive', '#/archive', ICON.book, 'Archive')}
    ${tab('me', '#/me', ICON.user, 'Me')}
  </nav></div>`;
}

// ---------------------------------------------------------------- install gate
function viewGate() {
  renderTabs(null);
  const name = esc(state.config?.appName || 'Word Club');
  $app.innerHTML = `
  <section class="screen no-tabs">
    <div class="hero">
      <span class="kicker">${name}</span>
      <h1>A new word every morning, with the family.</h1>
      <p>Add it to your Home Screen first. It then works like an app, remembers you, and can send you the daily word.</p>
    </div>
    <ol class="steps">
      <li><span class="n">1</span><span>Tap <b>Share</b> at the bottom of Safari</span>${ICON.share}</li>
      <li><span class="n">2</span><span>Scroll down and choose <b>Add to Home Screen</b></span>${ICON.plusBox}</li>
      <li><span class="n">3</span><span>Open <b>${name}</b> from your Home Screen</span></li>
    </ol>
    <div class="push-down stack">
      <p class="note">On iPhone, the Home Screen version keeps its own memory, so join from there, not from Safari.</p>
      <button class="link-btn" id="skip">Continue in Safari anyway</button>
    </div>
  </section>`;
  document.getElementById('skip').onclick = () => { sessionStorage.setItem('wc_skip_gate', '1'); go('#/join'); };
}

// ---------------------------------------------------------------- join
function viewJoin() {
  renderTabs(null);
  const colors = state.config.colors;
  let color = colors[Math.floor(Math.random() * colors.length)];
  const savedCode = store.get('wc_family_code') || '';
  $app.innerHTML = `
  <form class="screen no-tabs" id="join" novalidate>
    <div class="hero">
      <span class="kicker">${esc(state.config.appName)}</span>
      <h1>Who's joining?</h1>
      <p>No email, no password. This phone will remember you.</p>
    </div>
    <div class="field">
      <label for="name">Your name, as the family knows you</label>
      <input class="input" id="name" name="name" maxlength="30" autocomplete="given-name" autocapitalize="words" required>
    </div>
    <fieldset class="field">
      <legend>Pick your colour</legend>
      <div class="swatches" id="swatches"></div>
    </fieldset>
    <div class="field">
      <label for="code">Family code</label>
      <input class="input code" id="code" name="code" value="${esc(savedCode)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
      <span class="hint">${savedCode ? 'Filled in from your invite link.' : 'It was in the message with the link.'}</span>
    </div>
    <p class="error" id="err" role="alert"></p>
    <div class="push-down stack">
      <button class="btn" type="submit" id="go">See today's words</button>
      <a class="link-btn" href="#/rejoin">Joined before on another phone? Use your re-join code</a>
    </div>
  </form>`;
  const $sw = document.getElementById('swatches');
  const $name = document.getElementById('name');
  const drawSwatches = () => {
    $sw.innerHTML = colors.map((c) => `<button type="button" class="swatch" style="background:${c}" data-c="${c}" aria-pressed="${c === color}" aria-label="Colour ${c}">${c === color ? initial($name.value || '?') : ''}</button>`).join('');
  };
  drawSwatches();
  $sw.onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { color = b.dataset.c; drawSwatches(); } };
  $name.oninput = drawSwatches;
  if (!savedCode) $name.focus();
  document.getElementById('join').onsubmit = async (e) => {
    e.preventDefault();
    const $err = document.getElementById('err');
    const $go = document.getElementById('go');
    $err.textContent = '';
    const name = $name.value.trim();
    const familyCode = document.getElementById('code').value.trim();
    if (!name) { $err.textContent = 'Please add your name.'; $name.focus(); return; }
    if (!familyCode) { $err.textContent = 'Please add the family code.'; return; }
    $go.disabled = true;
    try {
      const out = await api('POST', '/api/join', { name, color, familyCode });
      signedIn(out);
      go('#/');
    } catch (err) {
      $err.textContent = err.message;
      $go.disabled = false;
    }
  };
}

function viewRejoin() {
  renderTabs(null);
  $app.innerHTML = `
  <form class="screen no-tabs" id="rejoin" novalidate>
    <a class="back" href="#/join">${ICON.chevronLeft}Back</a>
    <div class="hero">
      <h1>Welcome back</h1>
      <p>Enter the re-join code from the Me screen on your old phone. You'll keep your name, streak and comments.</p>
    </div>
    <div class="field">
      <label for="rc">Re-join code</label>
      <input class="input code" id="rc" placeholder="ABC-DEF-GHJ" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
    </div>
    <p class="error" id="err" role="alert"></p>
    <button class="btn" type="submit" id="go">Continue</button>
    <p class="hint" style="color:var(--muted);font-size:14px;margin:0">Lost it? Ask whoever runs the club to look you up. Or just join again with a new profile.</p>
  </form>`;
  document.getElementById('rc').focus();
  document.getElementById('rejoin').onsubmit = async (e) => {
    e.preventDefault();
    const $err = document.getElementById('err');
    const $go = document.getElementById('go');
    $go.disabled = true; $err.textContent = '';
    try {
      signedIn(await api('POST', '/api/rejoin', { code: document.getElementById('rc').value }));
      go('#/');
    } catch (err) { $err.textContent = err.message; $go.disabled = false; }
  };
}

function signedIn({ token, me }) {
  state.token = token; state.me = me;
  store.set('wc_token', token);
}

// ---------------------------------------------------------------- word page
function wordCardHTML(w) {
  return `
  <article class="word-card" aria-labelledby="w-${w.id}">
    <div class="row">
      <span class="pos">${esc(w.partOfSpeech)}</span>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" data-act="save" aria-pressed="${w.saved}" aria-label="${w.saved ? 'Saved' : 'Save word'}">${w.saved ? ICON.bookmarkFilled : ICON.bookmark}</button>
        ${'speechSynthesis' in window ? `<button class="icon-btn" data-act="speak" aria-label="Hear pronunciation">${ICON.speaker}</button>` : ''}
      </div>
    </div>
    <h2 id="w-${w.id}">${esc(w.word)}</h2>
    ${w.pronunciation ? `<span class="pron">${esc(w.pronunciation)}</span>` : ''}
    <p class="definition">${esc(w.definition)}</p>
    ${w.example ? `<p class="example">“${esc(w.example)}”</p>` : ''}
    ${w.origin ? `<div class="origin">Origin: ${esc(w.origin)}</div>` : ''}
  </article>`;
}

function reactionsHTML(w) {
  return REACTIONS.map((r) => {
    const on = w.myReactions.includes(r.kind);
    const n = w.reactions[r.kind] || 0;
    return `<button data-react="${r.kind}" aria-pressed="${on}" aria-label="${r.label}, ${n}"><span class="label">${r.label}</span><span class="count">${n}</span></button>`;
  }).join('');
}

function countNew(w) {
  const seen = store.get(`wc_seen_${w.id}`);
  if (!seen) return { n: 0, seen: null };
  let n = 0;
  const walk = (cs) => cs.forEach((c) => { if (c.createdAt > seen && c.author.id !== state.me.id) n++; walk(c.replies); });
  walk(w.comments);
  return { n, seen };
}

function latestCommentAt(w) {
  let max = '';
  const walk = (cs) => cs.forEach((c) => { if (c.createdAt > max) max = c.createdAt; walk(c.replies); });
  walk(w.comments);
  return max;
}

function commentHTML(c, seen, isReply = false) {
  const isNew = seen && c.createdAt > seen && c.author.id !== state.me.id;
  return `
  <div class="comment ${isNew ? 'is-new' : ''}" id="c-${c.id}">
    ${avatar(c.author, isReply ? 'xs' : 'sm')}
    <div class="main">
      <div class="meta"><b>${esc(c.author.name)}</b> <span>· ${esc(fmtWhen(c.createdAt))}</span></div>
      <p class="body">${esc(c.body)}</p>
      <div class="actions">
        <button data-like="${c.id}" aria-pressed="${c.liked}">${c.likes ? `Like · ${c.likes}` : 'Like'}</button>
        <button data-reply="${c.id}" data-name="${esc(c.author.name)}">Reply</button>
        ${c.canDelete ? `<button data-del="${c.id}">Delete</button>` : ''}
      </div>
      ${c.replies.length ? `<div class="replies">${c.replies.map((r) => commentHTML(r, seen, true)).join('')}</div>` : ''}
    </div>
  </div>`;
}

function commentsHTML(w) {
  const { n, seen } = countNew(w);
  const head = `<div class="comments-head">
      <h3>${w.commentCount === 0 ? 'No comments yet' : `${w.commentCount} comment${w.commentCount === 1 ? '' : 's'}`}</h3>
      ${n ? `<span class="new-pill">${n} new</span>` : ''}
    </div>`;
  if (!w.comments.length) return `${head}<div class="empty">Be the first. Even a one-liner counts.</div>`;
  return head + w.comments.map((c) => commentHTML(c, seen)).join('');
}

function markSeen(w) {
  const latest = latestCommentAt(w);
  const prev = store.get(`wc_seen_${w.id}`);
  // First visit: treat everything as seen so the badge only counts what arrives later.
  if (!prev || latest > prev) store.set(`wc_seen_${w.id}`, latest || new Date().toISOString());
}

function mountWordPage(w, { header }) {
  stopPolling();
  state.replyTo = null;
  const promptText = w.prompt || `Use ${w.word} in a sentence.`;
  $app.innerHTML = `
  <section class="screen">
    ${header}
    <div id="card">${wordCardHTML(w)}</div>
    <div class="reactions" id="reactions" role="group" aria-label="Reactions">${reactionsHTML(w)}</div>
    <div class="challenge"><span class="k">Today's challenge</span><span class="v">${esc(promptText)}</span></div>
    <form class="composer" id="composer">
      <div class="replying" id="replying" hidden><span></span><button type="button" id="cancel-reply">Cancel</button></div>
      <div class="box">
        ${avatar(state.me, 'sm')}
        <label class="sr-only" for="ta">Your comment</label>
        <textarea id="ta" rows="1" maxlength="1000" placeholder="Write your sentence…" enterkeyhint="send"></textarea>
        <button class="send" type="submit" id="send" aria-label="Post comment" disabled>${ICON.send}</button>
      </div>
    </form>
    <div class="comments" id="comments" aria-live="polite">${commentsHTML(w)}</div>
  </section>`;

  let current = w;
  const $ta = document.getElementById('ta');
  const $send = document.getElementById('send');
  const $replying = document.getElementById('replying');
  const draftKey = `wc_draft_${w.id}`;
  $ta.value = store.get(draftKey, '');
  const grow = () => { $ta.style.height = 'auto'; $ta.style.height = `${Math.min($ta.scrollHeight, 160)}px`; $send.disabled = !$ta.value.trim(); };
  grow();
  $ta.oninput = () => { grow(); store.set(draftKey, $ta.value); };

  const setReply = (r) => {
    state.replyTo = r;
    $replying.hidden = !r;
    if (r) { $replying.querySelector('span').textContent = `Replying to ${r.name}`; $ta.placeholder = `Reply to ${r.name}…`; $ta.focus(); }
    else $ta.placeholder = 'Write your sentence…';
  };
  document.getElementById('cancel-reply').onclick = () => setReply(null);

  const refresh = (nw, { comments = true, card = false } = {}) => {
    current = nw;
    document.getElementById('reactions').innerHTML = reactionsHTML(nw);
    if (comments) document.getElementById('comments').innerHTML = commentsHTML(nw);
    if (card) document.getElementById('card').innerHTML = wordCardHTML(nw);
    if (state.today) {
      const i = state.today.words.findIndex((x) => x.id === nw.id);
      if (i >= 0) state.today.words[i] = nw;
    }
  };

  document.getElementById('composer').onsubmit = async (e) => {
    e.preventDefault();
    const body = $ta.value.trim();
    if (!body) return;
    $send.disabled = true;
    try {
      const nw = await api('POST', `/api/words/${w.id}/comments`, { body, parentId: state.replyTo?.id });
      $ta.value = ''; store.del(draftKey); grow();
      setReply(null);
      refresh(nw);
      markSeen(nw);
      $live.textContent = 'Comment posted';
      maybeAskForNotifications();
    } catch (err) { toast(err.message); $send.disabled = false; }
  };
  $ta.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('composer').requestSubmit();
  };

  $app.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.react) {
        // Update straight away, then sync with the server.
        const kind = t.dataset.react;
        const on = current.myReactions.includes(kind);
        const optimistic = structuredClone(current);
        if (on) { optimistic.myReactions = optimistic.myReactions.filter((k) => k !== kind); optimistic.reactions[kind]--; }
        else {
          const opp = { knew: 'new', new: 'knew' }[kind];
          if (opp && optimistic.myReactions.includes(opp)) { optimistic.myReactions = optimistic.myReactions.filter((k) => k !== opp); optimistic.reactions[opp]--; }
          optimistic.myReactions.push(kind); optimistic.reactions[kind]++;
        }
        refresh(optimistic, { comments: false });
        if (navigator.vibrate) navigator.vibrate(8);
        refresh(await api('POST', `/api/words/${w.id}/reactions`, { kind }), { comments: false });
      } else if (t.dataset.act === 'save') {
        const { saved } = await api('POST', `/api/words/${w.id}/save`);
        refresh({ ...current, saved }, { comments: false, card: true });
        toast(saved ? 'Saved to your archive' : 'Removed from saved');
      } else if (t.dataset.act === 'speak') {
        const u = new SpeechSynthesisUtterance(current.word);
        u.lang = 'en-GB'; u.rate = 0.85;
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      } else if (t.dataset.reply) {
        setReply({ id: Number(t.dataset.reply), name: t.dataset.name });
      } else if (t.dataset.like) {
        await api('POST', `/api/comments/${t.dataset.like}/like`);
        refresh(await api('GET', `/api/words/${w.id}`));
      } else if (t.dataset.del) {
        if (!confirm('Delete this comment?')) return;
        refresh(await api('DELETE', `/api/comments/${t.dataset.del}`));
      }
    } catch (err) { toast(err.message); }
  };

  // Mark as read a moment after opening, so the "new" highlights are visible first.
  setTimeout(() => markSeen(current), 4000);

  // Keep comments fresh while the page is open.
  state.poll = setInterval(async () => {
    if (document.hidden) return;
    try {
      const nw = await api('GET', `/api/words/${w.id}`);
      if (JSON.stringify(nw) !== JSON.stringify(current)) refresh(nw);
    } catch { /* offline: try again next time */ }
  }, 15000);
}

async function viewToday() {
  renderTabs('today');
  const data = await api('GET', '/api/today');
  state.today = data;
  if (state.me) state.me.streak = data.streak;
  if (!data.words.length) {
    $app.innerHTML = `<section class="screen">${todayHeader(data)}<div class="empty">No word scheduled for today.${state.me.isAdmin ? ' <a href="#/admin">Add some in Admin</a>.' : ' Check back tomorrow!'}</div></section>`;
    return;
  }
  if (state.selected >= data.words.length) state.selected = 0;
  const w = data.words[state.selected];
  const switcher = data.words.length > 1
    ? `<div class="switcher" style="--n:${data.words.length}" role="group" aria-label="Today's words">${data.words.map((x, i) => `<button data-pick="${i}" aria-pressed="${i === state.selected}">${esc(x.word)}</button>`).join('')}</div>`
    : '';
  mountWordPage(w, { header: todayHeader(data) + switcher });
  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); state.selected = Number(b.dataset.pick); viewToday(); });
  });
}

function todayHeader(data) {
  const s = data.streak;
  return `<header class="topbar">
    <div><div class="eyebrow">${esc(fmtDay(data.date, { long: true }))}</div><h1>Today's word${data.words.length === 1 ? '' : 's'}</h1></div>
    <div class="topbar-right">
      ${s > 1 ? `<span class="pill">${s}-day streak</span>` : ''}
      <a href="#/me" aria-label="Me">${avatar(state.me)}</a>
    </div>
  </header>`;
}

async function viewWord(id) {
  renderTabs('archive');
  const w = await api('GET', `/api/words/${id}`);
  mountWordPage(w, {
    header: `<header class="topbar"><a class="back" href="#/archive">${ICON.chevronLeft}Archive</a><span class="eyebrow">${esc(fmtDay(w.date))}</span></header>`,
  });
}

// ---------------------------------------------------------------- archive
let archiveFilter = 'all';
async function viewArchive() {
  renderTabs('archive');
  const data = await api('GET', '/api/archive');
  $app.innerHTML = `
  <section class="screen">
    <header class="topbar"><h1 style="font-size:28px">Archive</h1></header>
    <label class="sr-only" for="q">Search words</label>
    <input class="input search" id="q" type="search" placeholder="Search words" autocomplete="off">
    <div class="chips" role="group" aria-label="Filter">
      <button data-f="all">All ${data.words.length}</button>
      <button data-f="new">New to me</button>
      <button data-f="saved">Saved</button>
    </div>
    <div id="list" class="stack"></div>
  </section>`;
  const weekLabel = (day) => {
    const ageDays = Math.round((Date.parse(`${data.today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
    const dow = (new Date(`${data.today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    if (ageDays <= dow) return 'This week';
    if (ageDays <= dow + 7) return 'Last week';
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
  };
  const draw = () => {
    document.querySelectorAll('[data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === archiveFilter)));
    const q = document.getElementById('q').value.trim().toLowerCase();
    let ws = data.words;
    if (archiveFilter === 'new') ws = ws.filter((w) => w.newToMe);
    if (archiveFilter === 'saved') ws = ws.filter((w) => w.saved);
    if (q) ws = ws.filter((w) => w.word.toLowerCase().includes(q) || w.definition.toLowerCase().includes(q));
    const groups = [];
    for (const w of ws) {
      const label = weekLabel(w.date);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, words: [] });
      groups[groups.length - 1].words.push(w);
    }
    document.getElementById('list').innerHTML = groups.length
      ? groups.map((g) => `<h2 class="section-label">${esc(g.label)}</h2><div class="list">${g.words.map((w) => `
        <a class="list-row" href="#/word/${w.id}">
          <span class="grow"><span class="w">${esc(w.word)}</span><span class="sub">${esc(w.definition)}</span></span>
          <span class="count" aria-label="${w.comments} comments">${ICON.bubble}${w.comments}</span>
        </a>`).join('')}</div>`).join('')
      : `<div class="empty">${archiveFilter === 'saved' ? 'Tap the bookmark on a word to save it here.' : archiveFilter === 'new' ? 'Words you mark “New to me” show up here.' : 'Nothing matches.'}</div>`;
  };
  document.querySelector('.chips').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { archiveFilter = b.dataset.f; draw(); } };
  document.getElementById('q').oninput = draw;
  draw();
}

// ---------------------------------------------------------------- notifications
function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enableNotifications() {
  if (!pushSupported) {
    toast(isIOS && !isStandalone ? 'Add the app to your Home Screen first' : "This browser can't do notifications");
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are off. You can turn them on in Settings.'); return false; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(state.config.vapidPublicKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  toast(`Done. You'll get the word at ${fmtClock(state.me.notifyTime)}.`);
  return true;
}

function fmtClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

function maybeAskForNotifications() {
  if (!pushSupported || Notification.permission !== 'default' || store.get('wc_asked_push')) return;
  store.set('wc_asked_push', true);
  const close = () => { $overlay.innerHTML = ''; };
  $overlay.innerHTML = `
  <div class="scrim" id="scrim">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="nt">
      <div class="grab" aria-hidden="true"></div>
      <div class="bell">${ICON.bell}</div>
      <h2 id="nt">Posted! Want the word each morning?</h2>
      <p>One notification a day, plus one when someone replies to you. Nothing else.</p>
      <div class="stack">
        <button class="btn" id="yes">Yes, at ${esc(fmtClock(state.me.notifyTime))}</button>
        <button class="btn ghost" id="no">Not now</button>
      </div>
    </div>
  </div>`;
  document.getElementById('yes').onclick = async () => { close(); try { await enableNotifications(); } catch (err) { toast(err.message); } };
  document.getElementById('no').onclick = close;
  document.getElementById('scrim').onclick = (e) => { if (e.target.id === 'scrim') close(); };
  document.getElementById('yes').focus();
}

// ---------------------------------------------------------------- me
async function viewMe() {
  renderTabs('me');
  const me = await api('GET', '/api/me');
  state.me = me;
  const sub = await currentSubscription().catch(() => null);
  const inviteUrl = `${location.origin}/?code=${encodeURIComponent(me.familyCode)}`;
  const joined = new Date(me.joinedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  let notifyBlock;
  if (sub) {
    notifyBlock = `
      <div class="setting"><label class="lbl" for="nt">Daily word at</label><input type="time" id="nt" value="${esc(me.notifyTime)}"></div>
      <div class="setting"><label class="lbl" for="nr">Replies to my comments</label><input type="checkbox" role="switch" class="toggle" id="nr" ${me.notifyReplies ? 'checked' : ''}></div>
      <div class="setting"><span class="lbl">Notifications are on</span><button class="btn small secondary" id="test">Send a test</button></div>`;
  } else if (!pushSupported) {
    notifyBlock = `<div class="setting"><span class="lbl">Notifications<small>${isIOS && !isStandalone ? 'Add the app to your Home Screen to turn these on.' : "This browser doesn't support them."}</small></span></div>`;
  } else {
    notifyBlock = `<div class="setting"><span class="lbl">Daily word notification<small>Off on this device</small></span><button class="btn small" id="on">Turn on</button></div>`;
  }

  $app.innerHTML = `
  <section class="screen">
    <div class="profile">
      ${avatar(me, 'lg')}
      <div><h1>${esc(me.name)}</h1><span class="since">Joined ${esc(joined)}${me.streak > 1 ? ` · ${me.streak}-day streak` : ''}</span></div>
    </div>
    <div class="stats">
      <div><b>${me.stats.wordsSeen}</b><span>words so far</span></div>
      <div><b>${me.stats.comments}</b><span>comments</span></div>
      <div><b>${me.stats.newToMe}</b><span>new to me</span></div>
    </div>

    <h2 class="section-label">Notifications</h2>
    <div class="list">${notifyBlock}</div>

    <h2 class="section-label">Profile</h2>
    <form class="list" id="profile">
      <div class="setting"><label class="lbl" for="pn">Name</label><input class="input" id="pn" value="${esc(me.name)}" maxlength="30" style="max-width:60%;min-height:44px;font-size:16px"></div>
      <div class="setting" style="flex-wrap:wrap"><span class="lbl">Colour</span><div class="swatches" id="pc" style="gap:8px">${state.config.colors.map((c) => `<button type="button" class="swatch" style="background:${c};width:36px;height:36px;font-size:14px" data-c="${c}" aria-pressed="${c === me.color}" aria-label="Colour ${c}">${c === me.color ? initial(me.name) : ''}</button>`).join('')}</div></div>
    </form>

    <section class="code-card" aria-labelledby="rck">
      <span class="k" id="rck">Your re-join code</span>
      <span class="code">${esc(me.rejoinCode)}</span>
      <p>New phone? Enter this when you join and you'll keep your name, streak and comments. Keep it somewhere safe.</p>
      <button class="btn small" id="copy">Copy code</button>
    </section>

    <h2 class="section-label">Invite</h2>
    <div class="list">
      <div class="setting"><span class="lbl">Family code<small>${esc(me.familyCode)}</small></span><button class="btn small" id="invite">Share invite</button></div>
    </div>

    ${me.isAdmin ? '<a class="btn secondary" href="#/admin">Admin: words and members</a>' : ''}
    <button class="link-btn" id="signout" style="color:var(--muted)">Sign out of this device</button>
  </section>`;

  const save = async (patch) => {
    try { state.me = await api('PATCH', '/api/me', patch); toast('Saved'); } catch (err) { toast(err.message); }
  };
  document.getElementById('on')?.addEventListener('click', async () => { try { if (await enableNotifications()) viewMe(); } catch (err) { toast(err.message); } });
  document.getElementById('nt')?.addEventListener('change', (e) => { if (e.target.value) save({ notifyTime: e.target.value }); });
  document.getElementById('nr')?.addEventListener('change', (e) => save({ notifyReplies: e.target.checked }));
  document.getElementById('test')?.addEventListener('click', async () => {
    try {
      // Make sure the server has this device's subscription, then ask it to send one.
      const s = await currentSubscription();
      if (s) await api('POST', '/api/push/subscribe', { subscription: s.toJSON() });
      const { sent } = await api('POST', '/api/push/test');
      toast(sent ? 'Sent. It should arrive in a few seconds.' : 'No device to send to. Try turning notifications off and on.');
    } catch (err) { toast(err.message); }
  });
  const $pn = document.getElementById('pn');
  $pn.addEventListener('change', () => { if ($pn.value.trim()) save({ name: $pn.value.trim() }).then(viewMe); });
  document.getElementById('profile').onsubmit = (e) => { e.preventDefault(); $pn.blur(); };
  document.getElementById('pc').onclick = async (e) => { const b = e.target.closest('[data-c]'); if (b) { await save({ color: b.dataset.c }); viewMe(); } };
  document.getElementById('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(me.rejoinCode); toast('Copied'); } catch { toast(me.rejoinCode); }
  };
  document.getElementById('invite').onclick = async () => {
    const text = `Join our ${state.config.appName}: a new word every day. Open the link on your phone, then Share → Add to Home Screen. Family code: ${me.familyCode}`;
    if (navigator.share) { try { await navigator.share({ title: state.config.appName, text, url: inviteUrl }); } catch { /* cancelled */ } }
    else { try { await navigator.clipboard.writeText(`${text}\n${inviteUrl}`); toast('Invite copied'); } catch { prompt('Copy this invite:', `${text}\n${inviteUrl}`); } }
  };
  document.getElementById('signout').onclick = async () => {
    if (!confirm(`Sign out of this device?\n\nWrite down your re-join code first: ${me.rejoinCode}`)) return;
    try {
      const s = await currentSubscription().catch(() => null);
      if (s) { await api('POST', '/api/push/unsubscribe', { endpoint: s.endpoint }); await s.unsubscribe(); }
      await api('POST', '/api/logout');
    } catch { /* ignore */ }
    state.token = null; state.me = null; store.del('wc_token');
    go('#/join');
  };
}

// ---------------------------------------------------------------- admin
async function viewAdmin() {
  renderTabs('me');
  if (!state.me?.isAdmin) { go('#/'); return; }
  const data = await api('GET', '/api/admin/overview');
  const days = [];
  for (const w of data.upcoming) {
    if (!days.length || days[days.length - 1].date !== w.date) days.push({ date: w.date, words: [] });
    days[days.length - 1].words.push(w);
  }
  const futureDays = days.filter((d) => d.date > data.today).length;
  const runsOut = data.lastDay ? fmtDay(data.lastDay, { long: true }) : null;
  const all = data.upcoming;

  $app.innerHTML = `
  <section class="screen">
    <header class="topbar">
      <div><span class="kicker-hot">Admin</span><h1 style="font-size:26px">Words &amp; members</h1></div>
      <a class="back" href="#/me">${ICON.chevronLeft}Me</a>
    </header>

    <p class="note">${futureDays ? `<b>${futureDays} day${futureDays === 1 ? '' : 's'}</b> queued after today at ${data.wordsPerDay} a day. The last one goes out on ${esc(runsOut)}.` : '<b>The queue is empty.</b> Add some words so tomorrow isn’t blank.'}</p>

    <button class="btn" id="add">Add a word</button>

    <h2 class="section-label">Schedule</h2>
    <div class="stack" id="queue">
      ${days.map((d) => `
        <div class="day-card">
          <span class="d">${d.date === data.today ? 'Today · ' : ''}${esc(fmtDay(d.date))}</span>
          ${d.words.map((w) => {
            const i = all.findIndex((x) => x.id === w.id);
            return `<div class="q-word">
              <span class="w">${esc(w.word)}</span>
              ${i > 0 && w.date > data.today && all[i - 1].date > data.today ? `<button data-up="${w.id}" data-other="${all[i - 1].id}" aria-label="Move ${esc(w.word)} earlier">Up</button>` : ''}
              <button data-edit="${w.id}" aria-label="Edit ${esc(w.word)}">Edit</button>
              ${w.date > data.today ? `<button data-rm="${w.id}" aria-label="Remove ${esc(w.word)}">Remove</button>` : ''}
            </div>`;
          }).join('')}
        </div>`).join('') || '<div class="empty">Nothing scheduled.</div>'}
    </div>

    <h2 class="section-label">Members (${data.members.length})</h2>
    <div class="list">
      ${data.members.map((m) => `
        <div class="setting">
          <span style="display:flex;align-items:center;gap:10px;min-width:0">${avatar(m, 'sm')}<span class="lbl">${esc(m.name)}${m.is_admin ? ' (admin)' : ''}<small>${m.comments} comments · ${m.push ? 'notifications on' : 'no notifications'}${m.last_seen ? ` · seen ${esc(fmtWhen(m.last_seen + (m.last_seen.endsWith('Z') ? '' : 'Z')))}` : ''}</small></span></span>
          ${m.id !== state.me.id ? `<button class="btn small danger" data-kick="${m.id}" data-name="${esc(m.name)}">Remove</button>` : ''}
        </div>`).join('')}
    </div>

    <h2 class="section-label">Family code</h2>
    <form class="list" id="fc">
      <div class="setting"><label class="lbl" for="fci">Code new people join with</label></div>
      <div class="setting" style="gap:8px"><input class="input code" id="fci" value="${esc(data.familyCode)}" style="min-height:44px;font-size:16px"><button class="btn small" type="submit">Save</button></div>
    </form>
  </section>`;

  document.getElementById('add').onclick = () => wordForm(null);
  document.getElementById('fc').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PATCH', '/api/admin/settings', { familyCode: document.getElementById('fci').value }); toast('Family code updated'); } catch (err) { toast(err.message); }
  };
  $app.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.edit) wordForm(all.find((w) => w.id === Number(b.dataset.edit)));
      else if (b.dataset.rm) {
        const w = all.find((x) => x.id === Number(b.dataset.rm));
        if (!confirm(`Remove “${w.word}”? Later words will move up a slot.`)) return;
        await api('DELETE', `/api/admin/words/${w.id}`); viewAdmin();
      } else if (b.dataset.up) {
        await api('POST', '/api/admin/move', { a: Number(b.dataset.up), b: Number(b.dataset.other) }); viewAdmin();
      } else if (b.dataset.kick) {
        if (!confirm(`Remove ${b.dataset.name}? Their comments will be deleted too.`)) return;
        await api('POST', `/api/admin/members/${b.dataset.kick}/remove`); viewAdmin();
      }
    } catch (err) { toast(err.message); }
  };
}

function wordForm(w) {
  const f = (id, label, val, { area = false, ph = '' } = {}) => `
    <div class="field">
      <label for="${id}">${label}</label>
      ${area ? `<textarea class="input" id="${id}" placeholder="${esc(ph)}">${esc(val)}</textarea>` : `<input class="input" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}">`}
    </div>`;
  $overlay.innerHTML = `
  <div class="scrim" id="scrim">
    <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="wf" id="wform">
      <div class="grab" aria-hidden="true"></div>
      <h2 id="wf">${w ? 'Edit word' : 'Add a word'}</h2>
      ${f('f-word', 'Word', w?.word || '', { ph: 'petrichor' })}
      ${f('f-pos', 'Part of speech', w?.partOfSpeech || '', { ph: 'noun' })}
      ${f('f-pron', 'Pronunciation', w?.pronunciation || '', { ph: '/ˈpɛtrɪkɔː/' })}
      ${f('f-def', 'Definition', w?.definition || '', { area: true })}
      ${f('f-ex', 'Example sentence', w?.example || '', { area: true })}
      ${f('f-or', 'Origin', w?.origin || '', { area: true })}
      ${f('f-pr', 'Challenge prompt', w?.prompt || '', { ph: 'Use it in a sentence about…' })}
      <p class="error" id="ferr" role="alert"></p>
      <div class="stack">
        <button class="btn" type="submit">${w ? 'Save changes' : 'Add to the end of the queue'}</button>
        <button class="btn ghost" type="button" id="fcancel">Cancel</button>
      </div>
    </form>
  </div>`;
  const close = () => { $overlay.innerHTML = ''; };
  document.getElementById('fcancel').onclick = close;
  document.getElementById('f-word').focus();
  document.getElementById('wform').onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value;
    const body = {
      word: v('f-word'), part_of_speech: v('f-pos'), pronunciation: v('f-pron'), definition: v('f-def'),
      example: v('f-ex'), origin: v('f-or'), prompt: v('f-pr'),
    };
    try {
      if (w) await api('PUT', `/api/admin/words/${w.id}`, body);
      else await api('POST', '/api/admin/words', body);
      close(); toast(w ? 'Saved' : 'Added'); viewAdmin();
    } catch (err) { document.getElementById('ferr').textContent = err.message; }
  };
}

// ---------------------------------------------------------------- router
async function render() {
  stopPolling();
  $overlay.innerHTML = '';
  $app.onclick = null;
  const hash = location.hash || '#/';
  try {
    if (!state.token) {
      if (hash === '#/rejoin') return viewRejoin();
      if (isIOS && !isStandalone && !sessionStorage.getItem('wc_skip_gate')) return viewGate();
      return viewJoin();
    }
    if (!state.me) state.me = await api('GET', '/api/me');
    if (hash === '#/join' || hash === '#/rejoin') { history.replaceState(null, '', '#/'); return viewToday(); }
    let m;
    if ((m = /^#\/word\/(\d+)$/.exec(hash))) return await viewWord(Number(m[1]));
    if (hash === '#/archive') return await viewArchive();
    if (hash === '#/me') return await viewMe();
    if (hash === '#/admin') return await viewAdmin();
    return await viewToday();
  } catch (err) {
    if (err.status === 401) return;
    $app.innerHTML = `<section class="screen"><div class="empty">${esc(err.message === 'Failed to fetch' ? "You're offline. Reconnect and try again." : err.message)}<br><br><button class="btn small" id="retry">Try again</button></div></section>`;
    document.getElementById('retry').onclick = render;
  }
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.config = await api('GET', '/api/config');
  } catch {
    $app.innerHTML = '<section class="screen"><div class="empty">Can’t reach the server. Check your connection and reopen the app.</div></section>';
    return;
  }
  document.title = state.config.appName;
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  // Coming back to the app after a while: refresh so today's words are current.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000 && state.token) render();
  });
  render();
}

boot();
