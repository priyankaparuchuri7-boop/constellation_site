/* Constellation: multiple habits, a mood with every check-in, and analytics. Data stays in this browser. */
(function () {
'use strict';
var KEY = 'constellation.habits.v1', OLD_KEY = 'constellation.v2', DAY = 864e5;
var MOODS = [{v: 1, e: '😞', l: 'Awful', c: '#8c9bf0'}, {v: 2, e: '😕', l: 'Low', c: '#b79cf2'}, {v: 3, e: '😐', l: 'Okay', c: '#7fd6c8'}, {v: 4, e: '🙂', l: 'Good', c: '#a6e88a'}, {v: 5, e: '😄', l: 'Great', c: '#ffd479'}];
var PALETTE = ['#ffd479', '#ff8f7a', '#6fe3b6', '#6cc6ff', '#d58bff', '#c5e86c', '#ff7eb6'];
var $ = function (s, r) { return (r || document).querySelector(s); };
var pad = function (n) { return String(n).padStart(2, '0'); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
var state = {tab: 'today', logging: null, removing: null, filter: 'all', confirmReset: false, flash: '', justLogged: null, storageOK: true, adding: false, intro: true};

/* ---------- dates ---------- */
function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function utc(k) { var a = k.split('-').map(Number); return Date.UTC(a[0], a[1] - 1, a[2]); }
function addDays(k, n) { var t = new Date(utc(k) + n * DAY); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
function dayDiff(a, b) { return Math.round((utc(a) - utc(b)) / DAY); }
function today() { return keyOf(new Date()); }
function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function weekday(k) { return (new Date(utc(k)).getUTCDay() + 6) % 7; } /* Monday = 0 */
function nice(k) { return new Date(utc(k)).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'}); }

/* ---------- storage ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function fresh() { return {habits: [], logs: []}; }
function migrate() {
  /* Carry over the single habit from the earlier study version, if there is one. */
  try {
    var r = localStorage.getItem(OLD_KEY); if (!r) return null;
    var o = JSON.parse(r); if (!o || !o.profile || !o.profile.habit) return null;
    var h = {id: uid(), name: o.profile.habit, created: o.profile.startDate || today()}, logs = [];
    Object.keys(o.checkins || {}).forEach(function (d) {
      var c = o.checkins[d]; logs.push({id: uid(), habitId: h.id, date: d, time: c.time || '', mood: 0, note: ''});
    });
    return {habits: [h], logs: logs};
  } catch (e) { return null; }
}
function load() {
  try {
    var r = localStorage.getItem(KEY);
    if (r) { var o = JSON.parse(r); return {habits: o.habits || [], logs: o.logs || []}; }
    return migrate() || fresh();
  } catch (e) { state.storageOK = false; return fresh(); }
}
var S = load();
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { state.storageOK = false; } }
function save() { S.updated = Date.now(); saveLocal(); schedulePush(); }
/* Check that this browser really keeps data, and ask it not to evict ours. */
(function () {
  try { localStorage.setItem('__probe', '1'); if (localStorage.getItem('__probe') !== '1') throw new Error('x'); localStorage.removeItem('__probe'); }
  catch (e) { state.storageOK = false; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
})();

/* ---------- account sync (Supabase, optional) ---------- */
var CFG = window.HT_CONFIG || {}, SESS_KEY = 'constellation.session';
var SB = {on: !!(CFG.supabaseUrl && CFG.supabaseAnonKey), session: null, status: '', sent: '', err: '', timer: null, busy: false};
function sbHeaders(tok) { return {'apikey': CFG.supabaseAnonKey, 'Authorization': 'Bearer ' + (tok || CFG.supabaseAnonKey), 'Content-Type': 'application/json'}; }
function sbReq(path, opt) {
  return fetch(CFG.supabaseUrl.replace(/\/$/, '') + path, opt).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { var e = new Error(t || r.status); e.status = r.status; throw e; });
    return r.status === 204 ? null : r.text().then(function (t) { return t ? JSON.parse(t) : null; });
  });
}
function setSession(x) { SB.session = x; try { if (x) localStorage.setItem(SESS_KEY, JSON.stringify(x)); else localStorage.removeItem(SESS_KEY); } catch (e) {} }
function sessFrom(j) {
  var old = SB.session || {};
  return {access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    email: (j.user && j.user.email) || old.email || '', uid: (j.user && j.user.id) || old.uid};
}
function loadSession() { try { var r = localStorage.getItem(SESS_KEY); SB.session = r ? JSON.parse(r) : null; } catch (e) { SB.session = null; } }
function token() {
  var x = SB.session; if (!x) return Promise.reject(new Error('no session'));
  if (x.expires_at - 60 > Date.now() / 1000) return Promise.resolve(x.access_token);
  return sbReq('/auth/v1/token?grant_type=refresh_token', {method: 'POST', headers: sbHeaders(), body: JSON.stringify({refresh_token: x.refresh_token})})
    .then(function (j) { setSession(sessFrom(j)); return SB.session.access_token; })
    .catch(function (e) { if (e.status >= 400 && e.status < 500) { setSession(null); SB.status = 'Session expired. Sign in again.'; softRender(); } throw e; });
}
function handleHash() {
  /* Returning from the emailed sign-in link: #access_token=...&refresh_token=... */
  if (!SB.on || location.hash.indexOf('access_token=') < 0 && location.hash.indexOf('error_description=') < 0) return Promise.resolve();
  var q = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (q.get('error_description')) { SB.err = 'That sign-in link did not work: ' + q.get('error_description').replace(/\+/g, ' ') + ' Request a new one.'; return Promise.resolve(); }
  var tok = q.get('access_token');
  return sbReq('/auth/v1/user', {headers: sbHeaders(tok)}).then(function (u) {
    setSession(sessFrom({access_token: tok, refresh_token: q.get('refresh_token'), expires_at: +q.get('expires_at') || 0, expires_in: +q.get('expires_in') || 3600, user: u}));
  }).catch(function () { SB.err = 'Could not finish signing in. Request a new link.'; });
}
function union(a, b) {
  var hs = {}, ls = {};
  (b.habits || []).concat(a.habits || []).forEach(function (h) { hs[h.id] = h; });
  (b.logs || []).concat(a.logs || []).forEach(function (l) { ls[l.habitId + '|' + l.date] = l; });
  return {habits: Object.keys(hs).map(function (k) { return hs[k]; }), logs: Object.keys(ls).map(function (k) { return ls[k]; }), updated: Date.now()};
}
function applyData(d) { S.habits = d.habits || []; S.logs = d.logs || []; S.updated = d.updated || Date.now(); saveLocal(); }
function pushNow() {
  if (!SB.on || !SB.session) return Promise.resolve();
  SB.status = 'Saving…';
  return token().then(function (tok) {
    var body = {user_id: SB.session.uid, data: {habits: S.habits, logs: S.logs, updated: S.updated || Date.now()}, updated_at: new Date().toISOString()};
    return sbReq('/rest/v1/user_data?on_conflict=user_id', {method: 'POST', headers: Object.assign(sbHeaders(tok), {'Prefer': 'resolution=merge-duplicates,return=minimal'}), body: JSON.stringify(body)});
  }).then(function () { SB.status = 'Saved to your account'; S.syncedAt = Date.now(); saveLocal(); softRender(); })
    .catch(function () { SB.status = 'Offline. Will retry when you make a change or reopen.'; softRender(); });
}
function schedulePush() { if (!SB.on || !SB.session) return; clearTimeout(SB.timer); SB.timer = setTimeout(pushNow, 700); }
function syncNow() {
  if (!SB.on || !SB.session || SB.busy) return Promise.resolve();
  SB.busy = true; SB.status = 'Syncing…'; softRender();
  return token().then(function (tok) {
    return sbReq('/rest/v1/user_data?select=data&user_id=eq.' + encodeURIComponent(SB.session.uid), {headers: sbHeaders(tok)});
  }).then(function (rows) {
    var remote = rows && rows[0] && rows[0].data, localHas = S.habits.length || S.logs.length;
    if (!remote) return pushNow();
    if (!S.syncedAt && localHas) { applyData(union(S, remote)); return pushNow(); }
    if ((remote.updated || 0) > (S.updated || 0)) { applyData(remote); S.syncedAt = Date.now(); saveLocal(); SB.status = 'Saved to your account'; return; }
    if ((S.updated || 0) > (remote.updated || 0)) return pushNow();
    SB.status = 'Saved to your account';
  }).catch(function () { SB.status = 'Offline. Your entries are kept on this device and will sync later.'; })
    .then(function () { SB.busy = false; softRender(); });
}
function softRender() {
  var a = document.activeElement;
  if (state.logging || (a && /INPUT|TEXTAREA/.test(a.tagName))) { var el = $('#acct-status'); if (el) el.textContent = SB.status; return; }
  render(true);
}
function accountBlock() {
  if (!SB.on) return '';
  if (SB.session) {
    return '<div class="acct row spread"><span class="note" id="acct-status" role="status">☁ ' + esc(SB.session.email) + ' · ' + esc(SB.status || 'Saved to your account') + '</span><span class="row"><button class="btn link" data-act="syncnow">Sync now</button><button class="btn link" data-act="signout">Sign out</button></span></div>';
  }
  return '<form class="panel" data-form="signin"><h3>Keep your data safe</h3><p class="note">Sign in with your email and your habits are saved to your account, so they survive cleared browsers and work on any device. No password: we email you a link.</p>' +
    (SB.sent ? '<p class="ok" role="status">Link sent to ' + esc(SB.sent) + '. Open it on this device to finish signing in.</p>' : '') +
    '<label class="f">Email<input type="email" id="si-email" autocomplete="email" placeholder="you@example.com" style="width:100%;background:var(--sky-0);border:1px solid var(--sky-2);color:var(--ink);border-radius:6px;padding:10px 12px;font:400 16px var(--font-body)"></label>' +
    '<div class="err" id="si-err" role="alert">' + esc(SB.err) + '</div><button class="btn primary" type="submit">Email me a sign-in link</button></form>';
}

/* ---------- data helpers ---------- */
function habitById(id) { return S.habits.filter(function (h) { return h.id === id; })[0]; }
function logOf(id, date) { return S.logs.filter(function (l) { return l.habitId === id && l.date === date; })[0]; }
function logsFor(id) { return S.logs.filter(function (l) { return l.habitId === id; }); }
function scoped(filter) { return filter === 'all' ? S.logs : logsFor(filter); }
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function moodsOf(logs) { return logs.filter(function (l) { return l.mood > 0; }).map(function (l) { return l.mood; }); }
function f1(x) { return x == null ? 'n/a' : x.toFixed(1); }
function isDone(l) { return l.done !== false; }
function doneOnly(a) { return a.filter(isDone); }
function hashStr(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function moodFace(v) { var m = MOODS[Math.round(v) - 1]; return m ? m.e : ''; }

function colorOf(h) { return (h && h.color) || PALETTE[Math.max(0, S.habits.indexOf(h)) % PALETTE.length]; }
function nextColor() { var used = S.habits.map(colorOf); return PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[S.habits.length % PALETTE.length]; }
function pickOne(a) { return a[Math.floor(Math.random() * a.length)]; }
function greeting() { var h = new Date().getHours(); return h < 5 ? 'Still up, night owl?' : h < 12 ? 'Good morning, stargazer' : h < 17 ? 'Good afternoon, stargazer' : h < 21 ? 'Good evening, stargazer' : 'Good night, stargazer'; }
function streaks(id) {
  var set = {}; doneOnly(logsFor(id)).forEach(function (l) { set[l.date] = 1; });
  var dates = Object.keys(set).sort(), best = 0, run = 0, prev = null;
  dates.forEach(function (d) { run = (prev && dayDiff(d, prev) === 1) ? run + 1 : 1; best = Math.max(best, run); prev = d; });
  var t = today(), d = set[t] ? t : addDays(t, -1), cur = 0;
  while (set[d]) { cur++; d = addDays(d, -1); }
  return {cur: cur, best: best};
}
function rate30(h) {
  var t = today(), span = Math.min(30, Math.max(1, dayDiff(t, h.created) + 1)), from = addDays(t, -(span - 1));
  var n = doneOnly(logsFor(h.id)).filter(function (l) { return l.date >= from && l.date <= t; }).length;
  return Math.round(100 * Math.min(1, n / span));
}

/* ---------- shell ---------- */
function shell(body) {
  var tabs = [['today', '🌙 Today'], ['analytics', '📈 Analytics']].map(function (t) {
    return '<button class="tab" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + t[1] + '</button>';
  }).join('');
  return '<div class="bar"><div class="bar-in"><span class="brand">Constellation</span><span class="status">' + esc(nice(today())) + '</span></div>' +
    '<nav class="tabs" role="tablist" aria-label="Sections">' + tabs + '</nav></div>' +
    '<main class="app" id="main" tabindex="-1">' + (state.storageOK ? '' : '<div class="banner" role="alert"><b>Your entries are not being saved.</b> This browser is blocking storage, which usually means a private or incognito window, or a setting that clears site data. Open the site in a normal window, then add your habits again. Until then, use Download backup in Analytics.</div>') + body + '</main>' +
    '<footer class="foot">' + (state.storageOK ? (SB.on ? (SB.session ? 'Your habits are saved to your account and kept on this device.' : 'Not signed in: your habits live only in this browser, and browsers can erase them. Sign in on the Today tab to keep them for good.') : 'Everything stays in this browser on this device. Use Export or Backup in Analytics to keep a copy.') : 'This browser is blocking storage, so entries will be lost when you close the page. Download a backup from Analytics before leaving.') + '</footer>';
}
function render(keepScroll) {
  var y = window.scrollY;
  document.body.classList.toggle('wide', state.tab === 'today');
  $('#app').innerHTML = shell(state.tab === 'today' ? viewToday() : viewAnalytics());
  state.intro = false;
  if (keepScroll) window.scrollTo(0, y);
}

/* ---------- today ---------- */
function addForm(canCancel) {
  var ideas = ['Exercise', 'Read', 'Drink water', 'Meditate', 'Sleep by 11'].filter(function (i) { return !S.habits.some(function (h) { return h.name.toLowerCase() === i.toLowerCase(); }); });
  return '<form class="panel" data-form="addhabit"><h3>Add a habit</h3>' +
    '<label class="f">Habit name<input type="text" id="hb-name" autocomplete="off" maxlength="60" placeholder="Walk for 20 minutes"></label>' +
    (ideas.length ? '<div class="chips" aria-label="Ideas">' + ideas.map(function (i) { return '<button type="button" class="chip" data-act="idea" data-h="' + esc(i) + '">' + esc(i) + '</button>'; }).join('') + '</div>' : '') +
    '<fieldset><legend>Pick its star colour</legend><div class="swatches">' + PALETTE.map(function (c, i) { return '<label class="sw"><input type="radio" name="color" value="' + c + '"' + (c === nextColor() ? ' checked' : '') + ' aria-label="Colour ' + (i + 1) + '"><span style="background:' + c + '"></span></label>'; }).join('') + '</div></fieldset>' +
    '<div class="err" id="hb-err" role="alert"></div><div class="row"><button class="btn primary" type="submit">Add habit</button>' + (canCancel ? '<button class="btn link" type="button" data-act="addclose">Cancel</button>' : '') + '</div></form>';
}
function logForm(h, existing) {
  var picks = MOODS.map(function (m) {
    return '<label class="mood" style="--mc:' + m.c + '"><input type="radio" name="mood" value="' + m.v + '"' + (existing && existing.mood === m.v ? ' checked' : '') + '><span><b>' + m.e + '</b>' + m.l + '</span></label>';
  }).join('');
  var wasDone = !existing || isDone(existing);
  return '<form class="logform" data-form="log" data-id="' + h.id + '" style="display:flex;flex-direction:column;gap:12px">' +
    '<fieldset><legend>Did you do it today?</legend><div class="pick">' +
    '<label class="mood"><input type="radio" name="done" value="1"' + (wasDone ? ' checked' : '') + '><span><b>⭐</b>Done</span></label>' +
    '<label class="mood"><input type="radio" name="done" value="0"' + (wasDone ? '' : ' checked') + '><span><b>🌑</b>Not today</span></label></div></fieldset>' +
    '<fieldset><legend>How do you feel right now?</legend><div class="moods">' + picks + '</div></fieldset>' +
    '<label class="f">Note (optional)<textarea name="note" maxlength="500" placeholder="What was it like?">' + esc(existing ? existing.note : '') + '</textarea></label>' +
    '<div class="err" role="alert"></div><div class="row"><button class="btn primary" type="submit">' + (existing ? 'Save changes' : 'Save check-in') + '</button><button class="btn link" type="button" data-act="cancel">Cancel</button></div></form>';
}
function habitCard(h) {
  var t = today(), rec = logOf(h.id, t), st = streaks(h.id), isDn = rec && isDone(rec), editing = state.logging === h.id, act = '', line = '';
  var streakTxt = st.cur > 0 ? '🔥 ' + st.cur + (st.cur === 1 ? ' day' : ' days') : 'Ready to start';
  if (!editing) {
    if (rec) {
      act = '<span class="face' + (state.justLogged === h.id ? ' pop' : '') + '">' + (rec.mood ? moodFace(rec.mood) : (isDn ? '✓' : '–')) + '</span>';
      line = '<p class="hline">' + (isDn ? 'Done' : 'Not done') + ' · ' + esc(rec.time) + (rec.mood ? ' · ' + esc(MOODS[rec.mood - 1].l.toLowerCase()) : '') +
        ' <button class="btn link" data-act="edit" data-id="' + h.id + '">Edit</button><button class="btn link" data-act="undo" data-id="' + h.id + '">Undo</button></p>' + (rec.note ? '<p class="hnote">' + esc(rec.note) + '</p>' : '');
    } else act = '<button class="btn primary sm" data-act="start" data-id="' + h.id + '">Log it</button>';
  }
  var rm = state.removing === h.id ? '<div class="row rmrow"><span class="note">Delete this habit and all its history?</span><button class="btn danger sm" data-act="rmgo" data-id="' + h.id + '">Delete</button><button class="btn sm" data-act="rmno">Keep</button></div>' : '';
  return '<section class="habit' + (isDn ? ' done' : '') + (rec && !isDn ? ' skipped' : '') + '" style="--hc:' + colorOf(h) + '" data-hid="' + h.id + '">' +
    '<div class="hrow"><span class="hstar" aria-hidden="true">★</span><div class="hinfo"><h3 class="name">' + esc(h.name) + '</h3><span class="streak">' + streakTxt + '</span></div>' + act +
    '<button class="kebab" data-act="rmask" data-id="' + h.id + '" aria-label="Remove ' + esc(h.name) + '" title="Remove habit">⋯</button></div>' +
    line + (editing ? logForm(h, rec) : '') + rm + '</section>';
}
function skyCard() {
  var t = today(), n = S.habits.length, lit = 0, rest = 0, i, doneToday = 0;
  for (i = 0; i < 28; i++) { var d = dayState('all', addDays(t, -i)); if (d.s === 'done') lit++; else if (d.s === 'skipped') rest++; }
  S.habits.forEach(function (x) { var r = logOf(x.id, t); if (r && isDone(r)) doneToday++; });
  var head = !n ? 'Your sky is waiting' : doneToday === n ? 'Every star is lit today ✨' : doneToday + ' of ' + n + ' lit today';
  return '<div class="plate skyplate">' + skySVG('all') + '<div class="skybar"><b>' + head + '</b><span class="note">' + lit + ' lit · ' + rest + ' rested · 28 days</span></div>' + skyLegend() + '</div>';
}
function viewToday() {
  var n = S.habits.length, h = '';
  var left = '<section class="greet"><h2>' + greeting() + ' ✨</h2>' + (n ? '' : '<p class="lede">Add your first habit, then log it to light your first star.</p>') + '</section>' + skyCard();
  if (state.flash) { h += '<p class="toast pop" role="status">' + esc(state.flash) + '</p>'; state.flash = ''; }
  h += S.habits.map(habitCard).join('');
  h += (!n || state.adding) ? addForm(n > 0) : '<button class="addbtn" data-act="addopen">＋ Add a habit</button>';
  h += accountBlock();
  return '<div class="home"><div class="homeL">' + left + '</div><div class="homeR">' + h + '</div></div>';
}

/* ---------- analytics ---------- */
function heatmap(filter) {
  var t = today(), weeks = 12, cell = 18, gap = 4, left = 26, top = 4;
  var start = addDays(addDays(t, -weekday(t)), -(weeks - 1) * 7), n = S.habits.length || 1;
  var byDay = {}; scoped(filter).forEach(function (l) { (byDay[l.date] = byDay[l.date] || []).push(l); });
  var out = '', w = left + weeks * (cell + gap), hgt = top + 7 * (cell + gap);
  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (d, i) { out += '<text x="0" y="' + (top + i * (cell + gap) + 13) + '" font-size="10" fill="var(--ink-dim)">' + d + '</text>'; });
  for (var c = 0; c < weeks; c++) {
    for (var r = 0; r < 7; r++) {
      var date = addDays(start, c * 7 + r); if (date > t) continue;
      var all = byDay[date] || [], list = doneOnly(all), op = 0, tip = nice(date) + ': ', fill = 'var(--sky-2)';
      if (list.length) {
        fill = filter === 'all' ? 'var(--star)' : colorOf(habitById(filter));
        if (filter === 'all') { op = .3 + .7 * Math.min(1, list.length / n); tip += list.length + ' of ' + n + ' habits'; }
        else { var m = list[0].mood; op = m ? .3 + .7 * (m - 1) / 4 : .6; tip += 'done' + (m ? ', ' + MOODS[m - 1].l.toLowerCase() : ''); }
      } else if (all.length) { fill = 'var(--ember)'; op = .55; tip += 'not done'; }
      else { op = .55; tip += 'nothing logged'; }
      out += '<rect x="' + (left + c * (cell + gap)) + '" y="' + (top + r * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="4" fill="' + fill + '" opacity="' + op.toFixed(2) + '"><title>' + esc(tip) + '</title></rect>';
    }
  }
  return '<svg viewBox="0 0 ' + w + ' ' + hgt + '" role="img" aria-label="Check-ins over the last 12 weeks">' + out + '</svg>';
}
function moodTrend(filter) {
  var t = today(), days = 30, W = 600, H = 190, L = 34, R = 10, T = 10, B = 24;
  var by = {}; scoped(filter).forEach(function (l) { if (l.mood > 0) (by[l.date] = by[l.date] || []).push(l.mood); });
  var pts = [];
  for (var i = 0; i < days; i++) { var d = addDays(t, -(days - 1 - i)); if (by[d]) pts.push({i: i, v: mean(by[d]), d: d}); }
  if (!pts.length) return '';
  var x = function (i) { return L + (W - L - R) * i / (days - 1); }, y = function (v) { return T + (H - T - B) * (5 - v) / 4; }, out = '';
  MOODS.forEach(function (m) { out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(m.v) + '" y2="' + y(m.v) + '" stroke="var(--sky-2)" stroke-width="1"/><text x="2" y="' + (y(m.v) + 5) + '" font-size="14">' + m.e + '</text>'; });
  out += '<text x="' + L + '" y="' + (H - 6) + '" font-size="10" fill="var(--ink-dim)">30 days ago</text><text x="' + (W - R) + '" y="' + (H - 6) + '" font-size="10" fill="var(--ink-dim)" text-anchor="end">today</text>';
  if (pts.length > 1) out += '<polyline fill="none" stroke="var(--thread)" stroke-width="1.6" points="' + pts.map(function (p) { return x(p.i).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ') + '"/>';
  pts.forEach(function (p) { out += '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="4" fill="var(--star)"><title>' + esc(nice(p.d)) + ': ' + p.v.toFixed(1) + ' / 5</title></circle>'; });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Average mood per day over the last 30 days">' + out + '</svg>';
}
function insight() {
  var dm = moodsOf(doneOnly(S.logs)), sm = moodsOf(S.logs.filter(function (l) { return !isDone(l); }));
  if (dm.length >= 3 && sm.length >= 3 && mean(dm) - mean(sm) >= .3) return '<p class="insight">You feel better on days you do your habits (' + f1(mean(dm)) + ' / 5) than on days you skip them (' + f1(mean(sm)) + ' / 5).</p>';
  var rows = S.habits.map(function (h) { var m = moodsOf(doneOnly(logsFor(h.id))); return {name: h.name, avg: mean(m), n: m.length}; }).filter(function (r) { return r.n >= 3; });
  if (rows.length < 2) return '';
  rows.sort(function (a, b) { return b.avg - a.avg; });
  var hi = rows[0], lo = rows[rows.length - 1];
  if (hi.avg - lo.avg < .3) return '<p class="insight">You feel about the same after all your habits so far.</p>';
  return '<p class="insight">You tend to feel best after <b>' + esc(hi.name) + '</b> (' + f1(hi.avg) + ' / 5) and least good after <b>' + esc(lo.name) + '</b> (' + f1(lo.avg) + ' / 5).</p>';
}
function viewAnalytics() {
  if (!S.habits.length) return '<section class="sect"><h2>Analytics</h2></section><div class="empty">Add a habit on the Today tab and log it a few times. Your streaks and mood patterns appear here.</div>' + dataSection();
  if (state.filter !== 'all' && !habitById(state.filter)) state.filter = 'all';
  var f = state.filter, logs = scoped(f), t = today(), weekFrom = addDays(t, -6), h = '';
  var moods = moodsOf(logs.filter(function (l) { return l.date >= addDays(t, -29); }));
  var weekN = doneOnly(logs).filter(function (l) { return l.date >= weekFrom; }).length;
  var bestCur = Math.max.apply(null, S.habits.map(function (x) { return streaks(x.id).cur; }));
  h += '<section class="sect"><h2>Analytics</h2>' + filterChips(f) + '</section>';
  var single = f === 'all' ? null : streaks(f);
  h += '<dl class="tiles">' +
    '<div class="tile"><dt>Check-ins, 7 days</dt><dd>' + weekN + '</dd></div>' +
    '<div class="tile"><dt>' + (single ? 'Current streak' : 'Longest streak now') + '</dt><dd>' + (single ? single.cur : bestCur) + '</dd></div>' +
    (single ? '<div class="tile"><dt>Best streak</dt><dd>' + single.best + '</dd></div>' : '<div class="tile"><dt>Days done</dt><dd>' + doneOnly(logs).length + '</dd></div>') +
    '<div class="tile"><dt>Mood, 30 days</dt><dd>' + (moods.length ? moodFace(mean(moods)) + ' ' + f1(mean(moods)) : 'n/a') + '</dd></div></dl>';
  if (f === 'all') h += insight();
  h += '<section class="sect"><h3>Last 12 weeks</h3><div class="plate">' + heatmap(f) + '<p class="cap">' + (f === 'all' ? 'Gold: habits done (brighter = more of them). Orange: logged as not done.' : 'Gold: done (brighter = you felt better). Orange: logged as not done.') + '</p></div></section>';
  var trend = moodTrend(f);
  h += '<section class="sect"><h3>Mood over the last 30 days</h3>' + (trend ? '<div class="plate">' + trend + '</div>' : '<p class="note">Log a habit with a mood to see your trend.</p>') + '</section>';
  var all = moodsOf(logs);
  if (all.length) {
    var counts = MOODS.map(function (m) { return all.filter(function (v) { return v === m.v; }).length; }), mx = Math.max.apply(null, counts.concat([1]));
    h += '<section class="sect"><h3>How you feel when you log</h3><div class="bars">' + MOODS.map(function (m, i) {
      return '<div class="bar-row"><span>' + m.e + ' ' + m.l + '</span><i style="width:' + Math.round(100 * counts[i] / mx) + '%"></i><span class="mono">' + counts[i] + '</span></div>';
    }).join('') + '</div></section>';
  }
  h += '<section class="sect"><h3>By habit</h3><div class="tbl"><table><thead><tr><th>Habit</th><th class="num">Streak</th><th class="num">Best</th><th class="num">30 days</th><th class="num">Mood</th><th class="num">Done</th></tr></thead><tbody>' +
    S.habits.map(function (x) {
      var st = streaks(x.id), m = mean(moodsOf(logsFor(x.id)));
      return '<tr><td>' + esc(x.name) + '</td><td class="num">' + st.cur + '</td><td class="num">' + st.best + '</td><td class="num">' + rate30(x) + '%</td><td class="num">' + (m == null ? 'n/a' : moodFace(m) + ' ' + f1(m)) + '</td><td class="num">' + doneOnly(logsFor(x.id)).length + '</td></tr>';
    }).join('') + '</tbody></table></div></section>';
  var recent = logs.slice().sort(function (a, b) { return (b.date + b.time) < (a.date + a.time) ? -1 : 1; }).filter(function (l) { return l.note; }).slice(0, 5);
  if (recent.length) h += '<section class="sect"><h3>Recent notes</h3>' + recent.map(function (l) { var x = habitById(l.habitId); return '<div class="recent"><span class="meta">' + esc(nice(l.date)) + ' · ' + esc(x ? x.name : '') + (l.mood ? ' · ' + moodFace(l.mood) : '') + (isDone(l) ? '' : ' · not done') + '</span><p>' + esc(l.note) + '</p></div>'; }).join('') + '</section>';
  return h + dataSection();
}
/* ---------- constellation ---------- */
var SPARK = 'M0,-12 L2.4,-2.4 L12,0 L2.4,2.4 L0,12 L-2.4,2.4 L-12,0 L-2.4,-2.4Z';
function dayState(filter, date) {
  var rel = dayDiff(date, today());
  if (rel > 0) return {s: 'future'};
  var list = scoped(filter).filter(function (l) { return l.date === date; }), done = doneOnly(list), n = filter === 'all' ? Math.max(1, S.habits.length) : 1, m = mean(moodsOf(list));
  if (done.length) return {s: 'done', frac: Math.min(1, done.length / n), mood: m, count: done.length, n: n, ids: done.map(function (l) { return l.habitId; })};
  if (list.length) return {s: 'skipped', mood: m};
  return {s: rel === 0 ? 'today' : 'none'};
}
function todayNode(cx, cy, st) {
  var n = S.habits.length, t = today(), R = 24 + Math.min(n, 8) * 1.5, out = '', i, doneN = 0, lastNew = state.justLogged, newDone = false;
  var title = '<title>' + esc('Today: ' + (st.s === 'done' ? st.count + ' of ' + n + ' habits done' : 'not lit yet')) + '</title>';
  for (i = 0; i < n; i++) {
    var hb = S.habits[i], rec = logOf(hb.id, t), col = colorOf(hb), ang = -Math.PI / 2 + (2 * Math.PI * i) / n, x = cx + Math.cos(ang) * R, y = cy + Math.sin(ang) * R, isNew = lastNew === hb.id;
    if (rec && isDone(rec)) {
      doneN++; if (isNew) newDone = true;
      out += '<g' + (isNew ? ' class="newstar"' : '') + '><title>' + esc(hb.name + ': done') + '</title><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="17" fill="url(#g-' + col.slice(1) + ')"/><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" fill="' + col + '"/></g>';
    } else if (rec) {
      out += '<circle' + (isNew ? ' class="newstar"' : '') + ' cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" fill="none" stroke="var(--ember)" stroke-width="1.6" stroke-dasharray="2 2"><title>' + esc(hb.name + ': not done') + '</title></circle>';
    } else {
      out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" fill="none" stroke="' + col + '" stroke-width="1.6" opacity=".7"><title>' + esc(hb.name + ': waiting') + '</title></circle>';
    }
  }
  var centre;
  if (doneN > 0) {
    var sc = (.9 + .8 * doneN / n).toFixed(2);
    centre = '<g class="' + (newDone ? 'newstar' : '') + '">' + title + '<circle cx="' + cx + '" cy="' + cy + '" r="' + (30 + 16 * doneN / n).toFixed(1) + '" fill="url(#cs-glow)"/><path d="' + SPARK + '" transform="translate(' + cx + ' ' + cy + ') scale(' + sc + ')" fill="#ffe3a1"/></g>' + (newDone ? '<circle class="ringout" cx="' + cx + '" cy="' + cy + '" r="18" fill="none" stroke="#ffe3a1" stroke-width="1.6"/>' : '');
  } else centre = '<circle class="pulse" cx="' + cx + '" cy="' + cy + '" r="9" fill="none" stroke="var(--star)" stroke-width="1.6" stroke-dasharray="2 3">' + title + '</circle>';
  return centre + out + '<text x="' + cx + '" y="' + (cy + R + 18) + '" text-anchor="middle" font-size="11" fill="var(--ink-dim)">today</text>';
}
function skySVG(filter) {
  var L = 28, W = 600, H = 340, t = today(), r = rng(hashStr(filter)), pts = [], p0 = r() * 6.28, amp = 55 + r() * 30, out = '', i, j;
  for (i = 0; i < L; i++) {
    var u = i / (L - 1), px = 40 + u * 484 + (r() - .5) * 26, py = 170 + Math.sin(u * 5.2 + p0) * amp + (r() - .5) * 50;
    pts.push([Math.round(px), Math.round(Math.max(54, Math.min(284, py)))]);
  }
  var bg = rng(777);
  for (i = 0; i < 70; i++) {
    var x = bg() * W, y = bg() * H, rad = .4 + bg() * 1, o = .2 + bg() * .5, tw = bg() < .3;
    out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + rad.toFixed(2) + '" fill="var(--ink)" opacity="' + o.toFixed(2) + '"' + (tw ? ' class="tw" style="animation-delay:' + (bg() * 4).toFixed(1) + 's"' : '') + '/>';
  }
  var days = [];
  for (i = 0; i < L; i++) { var date = addDays(t, -(L - 1 - i)); days.push({date: date, st: dayState(filter, date)}); }
  for (i = 1; i < L; i++) {
    var a = days[i - 1].st, b = days[i].st; if (b.s === 'future') continue;
    var both = a.s === 'done' && b.s === 'done';
    out += '<line x1="' + pts[i - 1][0] + '" y1="' + pts[i - 1][1] + '" x2="' + pts[i][0] + '" y2="' + pts[i][1] + '" stroke="var(--thread)" stroke-width="' + (both ? 1.5 : 1.1) + '" ' + (both ? 'opacity=".9"' : 'stroke-dasharray="3 6" opacity=".4"') + '/>';
  }
  for (j = 0; j < L; j++) {
    var d = days[j], st = d.st, cx = pts[j][0], cy = pts[j][1], tip = nice(d.date) + ': ';
    if (st.s === 'future') { out += '<circle cx="' + cx + '" cy="' + cy + '" r="1.8" fill="var(--thread)" opacity=".28"/>'; continue; }
    if (j === L - 1 && filter === 'all' && S.habits.length) { out += todayNode(cx, cy, st); continue; }
    if (st.s === 'done') {
      var rr = 2.4 + .7 * (st.mood || 3), big = weekday(d.date) === 6, col = '#ffe3a1';
      if (filter !== 'all') col = colorOf(habitById(filter));
      else { var uniq = st.ids.filter(function (x, k) { return st.ids.indexOf(x) === k; }); if (uniq.length === 1) col = colorOf(habitById(uniq[0])); }
      tip += (filter === 'all' ? st.count + ' of ' + st.n + ' habits done' : 'done') + (st.mood ? ', felt ' + MOODS[Math.round(st.mood) - 1].l.toLowerCase() : '');
      out += '<g' + (state.intro ? ' class="sp" style="animation-delay:' + (j * 0.045).toFixed(2) + 's"' : '') + ' opacity="' + (.55 + .45 * st.frac).toFixed(2) + '"><title>' + esc(tip) + '</title><circle cx="' + cx + '" cy="' + cy + '" r="' + (big ? 30 : 12 + rr * 2.2).toFixed(1) + '" fill="url(#g-' + col.slice(1) + ')"/>' +
        (big ? '<path d="' + SPARK + '" transform="translate(' + cx + ' ' + cy + ') scale(' + (.8 + .1 * (st.mood || 3)).toFixed(2) + ')" fill="' + col + '"/>' : '<circle cx="' + cx + '" cy="' + cy + '" r="' + rr.toFixed(1) + '" fill="' + col + '"/>') + '</g>';
    } else if (st.s === 'skipped') {
      tip += 'not done' + (st.mood ? ', felt ' + MOODS[Math.round(st.mood) - 1].l.toLowerCase() : '');
      out += '<circle cx="' + cx + '" cy="' + cy + '" r="6.5" fill="none" stroke="var(--ember)" stroke-width="1.3" stroke-dasharray="2 3" opacity=".9"><title>' + esc(tip) + '</title></circle>';
    } else if (st.s === 'today') {
      out += '<circle class="pulse" cx="' + cx + '" cy="' + cy + '" r="7" fill="none" stroke="var(--star)" stroke-width="1.4" stroke-dasharray="2 3"><title>' + esc(nice(d.date) + ': today, not logged yet') + '</title></circle>';
    } else out += '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="var(--ink-dim)" opacity=".5"><title>' + esc(tip + 'nothing logged') + '</title></circle>';
  }
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Your last 28 days as a constellation. Lit stars are days you did it, brighter and bigger when you felt better. Today shows one dot per habit.">' +
    glowDefs() + out + '</svg>';
}
function glowDefs() {
  var g = function (id, c) { return '<radialGradient id="' + id + '"><stop offset="0" stop-color="' + c + '" stop-opacity=".85"/><stop offset=".35" stop-color="' + c + '" stop-opacity=".22"/><stop offset="1" stop-color="' + c + '" stop-opacity="0"/></radialGradient>'; };
  return '<defs>' + g('cs-glow', '#ffe3a1') + ['#ffe3a1'].concat(PALETTE).map(function (c) { return g('g-' + c.slice(1), c); }).join('') + '</defs>';
}
function skyLegend() {
  var dot = function (inner) { return '<svg width="20" height="20" viewBox="-11 -11 22 22" aria-hidden="true">' + inner + '</svg>'; };
  return '<div class="legend"><span>' + dot('<circle r="9" fill="url(#cs-glow)"/><circle r="3.3" fill="var(--star)"/>') + 'Done · bigger = happier</span>' +
    '<span>' + dot('<circle r="6" fill="none" stroke="var(--ember)" stroke-width="1.3" stroke-dasharray="2 3"/>') + 'Not done</span>' +
    '</div>';
}
function filterChips(f) {
  return '<div class="chips" role="group" aria-label="Habit filter"><button class="chip" data-act="filter" data-id="all" aria-pressed="' + (f === 'all') + '">All habits</button>' + S.habits.map(function (x) { return '<button class="chip" style="--hc:' + colorOf(x) + '" data-act="filter" data-id="' + x.id + '" aria-pressed="' + (f === x.id) + '">' + esc(x.name) + '</button>'; }).join('') + '</div>';
}
function dataSection() {
  var h = '<details><summary>Export, backup and reset</summary><div class="sect"><p class="note" id="datamsg" role="status"></p><div class="row">' +
    (S.logs.length ? '<button class="btn" data-act="csv">Export CSV</button>' : '') +
    (S.habits.length ? '<button class="btn" data-act="backup">Download backup</button>' : '') +
    '<label class="btn" style="cursor:pointer">Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label></div>';
  if (!state.confirmReset) h += '<div class="row"><button class="btn danger" data-act="resetask">Delete all data</button></div>';
  else h += '<p>This removes every habit and check-in from this browser. It cannot be undone.</p><div class="row"><button class="btn danger" data-act="resetgo">Delete everything</button><button class="btn" data-act="resetno">Keep my data</button></div>';
  return h + '</div></details>';
}
function msg(t) { var el = $('#datamsg'); if (el) el.textContent = t; }

/* ---------- export ---------- */
function download(name, text, type) {
  var b = new Blob([text], {type: type || 'text/plain'}), u = URL.createObjectURL(b), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 600);
}
function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csv() {
  var rows = ['habit,date,time,done,mood,mood_label,note'];
  S.logs.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (l) {
    var h = habitById(l.habitId); rows.push([h ? h.name : '', l.date, l.time, isDone(l) ? 'yes' : 'no', l.mood || '', l.mood ? MOODS[l.mood - 1].l : '', l.note].map(csvCell).join(','));
  });
  return rows.join('\n');
}

/* ---------- fun ---------- */
function burst(id, color) {
  var sk = document.querySelector('.homeL');
  if (sk) { var q = sk.getBoundingClientRect(); if (q.bottom < 140 || q.top > window.innerHeight - 140) sk.scrollIntoView({behavior: 'smooth', block: 'start'}); }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var el = document.querySelector('.skyplate .newstar') || document.querySelector('[data-hid="' + id + '"] .face'); if (!el) return;
  var r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (var i = 0; i < 18; i++) {
    var sp = document.createElement('i'), ang = (Math.PI * 2 * i) / 18 + Math.random() * .4, dist = 45 + Math.random() * 60;
    sp.className = 'spark'; sp.textContent = i % 3 === 0 ? '✦' : '•';
    sp.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;color:' + (i % 2 ? color : '#ffe3a1') + ';--dx:' + Math.round(Math.cos(ang) * dist) + 'px;--dy:' + Math.round(Math.sin(ang) * dist) + 'px';
    document.body.appendChild(sp); (function (n) { setTimeout(function () { n.remove(); }, 1000); })(sp);
  }
}
function mountBg() {
  if (document.getElementById('bg')) return;
  var d = document.createElement('div'), r = rng(42), a = [], b = [], i;
  d.id = 'bg'; d.setAttribute('aria-hidden', 'true');
  for (i = 0; i < 60; i++) a.push((r() * 100).toFixed(1) + 'vw ' + (r() * 100).toFixed(1) + 'vh 0 ' + (r() < .2 ? 1 : 0) + 'px rgba(233,237,249,' + (.15 + r() * .45).toFixed(2) + ')');
  for (i = 0; i < 24; i++) b.push((r() * 100).toFixed(1) + 'vw ' + (r() * 100).toFixed(1) + 'vh 0 1px rgba(255,227,161,' + (.35 + r() * .4).toFixed(2) + ')');
  d.innerHTML = '<i class="stars"></i><i class="stars tw2"></i><i class="shoot s1"></i><i class="shoot s2"></i>';
  d.children[0].style.boxShadow = a.join(','); d.children[1].style.boxShadow = b.join(',');
  document.body.appendChild(d);
}

/* ---------- actions ---------- */
var actions = {
  signout: function () { setSession(null); SB.status = ''; SB.sent = ''; S.syncedAt = 0; saveLocal(); render(true); },
  syncnow: function () { SB.busy = false; syncNow(); },
  addopen: function () { state.adding = true; state.logging = null; render(true); var el = $('#hb-name'); if (el) el.focus(); },
  addclose: function () { state.adding = false; render(true); },
  tab: function (b) { state.tab = b.dataset.tab; state.intro = state.tab === 'today'; state.logging = null; state.removing = null; state.confirmReset = false; render(); window.scrollTo(0, 0); },
  idea: function (b) { var el = $('#hb-name'); if (el) { el.value = b.dataset.h; el.focus(); } },
  start: function (b) { state.logging = b.dataset.id; state.removing = null; render(true); },
  edit: function (b) { state.logging = b.dataset.id; render(true); },
  cancel: function () { state.logging = null; render(true); },
  undo: function (b) { S.logs = S.logs.filter(function (l) { return !(l.habitId === b.dataset.id && l.date === today()); }); save(); render(true); },
  rmask: function (b) { state.removing = b.dataset.id; state.logging = null; render(true); },
  rmno: function () { state.removing = null; render(true); },
  rmgo: function (b) { var id = b.dataset.id; S.habits = S.habits.filter(function (h) { return h.id !== id; }); S.logs = S.logs.filter(function (l) { return l.habitId !== id; }); state.removing = null; save(); render(true); },
  filter: function (b) { state.filter = b.dataset.id; render(true); },
  csv: function () { download('constellation-' + today() + '.csv', csv(), 'text/csv'); msg('CSV downloaded.'); },
  backup: function () { download('constellation-backup-' + today() + '.json', JSON.stringify(S), 'application/json'); msg('Backup downloaded.'); },
  resetask: function () { state.confirmReset = true; render(true); },
  resetno: function () { state.confirmReset = false; render(true); },
  resetgo: function () { S = fresh(); save(); state.confirmReset = false; state.filter = 'all'; render(); window.scrollTo(0, 0); }
};
var forms = {
  signin: function () {
    var email = $('#si-email').value.trim(), err = $('#si-err');
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
    err.textContent = 'Sending…';
    sbReq('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + '/'), {method: 'POST', headers: sbHeaders(), body: JSON.stringify({email: email, create_user: true})})
      .then(function () { SB.sent = email; SB.err = ''; render(true); })
      .catch(function () { var e2 = $('#si-err'); if (e2) e2.textContent = 'Could not send the link. Check the address and try again.'; });
  },
  addhabit: function () {
    var name = $('#hb-name').value.trim(), err = $('#hb-err');
    if (!name) { err.textContent = 'Give your habit a name.'; return; }
    if (S.habits.some(function (h) { return h.name.toLowerCase() === name.toLowerCase(); })) { err.textContent = 'You already have a habit with that name.'; return; }
    var cp = document.querySelector('input[name=color]:checked'); S.habits.push({id: uid(), name: name, created: today(), color: cp ? cp.value : nextColor()}); save(); state.adding = false; state.flash = 'New star on the way: ' + name + ' ✨'; render(true);
  },
  log: function (f) {
    var id = f.dataset.id, pick = f.querySelector('input[name=mood]:checked'), err = f.querySelector('.err');
    if (!pick) { err.textContent = 'Pick how you feel.'; return; }
    var now = new Date(), note = f.querySelector('textarea').value.trim(), ex = logOf(id, today()), dn = f.querySelector('input[name=done]:checked').value === '1';
    if (ex) { ex.mood = +pick.value; ex.note = note; ex.done = dn; }
    else S.logs.push({id: uid(), habitId: id, date: today(), time: hhmm(now), mood: +pick.value, done: dn, note: note});
    var hb = habitById(id), msgs;
    if (!dn) msgs = ['That is okay. Tomorrow the sky is clear again. 🌙', 'Rest is part of the pattern. 💤', 'Noted. Be kind to yourself tonight. 💙'];
    else if (+pick.value >= 4) msgs = ['Shining bright! ✨', 'You lit that one up. 🌟', 'Look at that glow. ⭐'];
    else msgs = ['You showed up, and that counts. ⭐', 'Lit, even on a heavy day. 🕯️', 'Proud of you for doing it anyway. 💫'];
    state.flash = pickOne(msgs);
    state.logging = null; state.justLogged = id; save();
    if (dn) { var cur = streaks(id).cur; if ([3, 7, 14, 21, 30, 50, 100, 365].indexOf(cur) >= 0) state.flash = '🏆 ' + cur + ' days in a row of ' + hb.name + '! ' + state.flash; }
    render(true);
    if (dn) burst(id, colorOf(hb));
    setTimeout(function () { state.justLogged = null; }, 800);
  }
};

document.addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (!b) return; var fn = actions[b.dataset.act]; if (fn) fn(b, e); });
document.addEventListener('submit', function (e) { e.preventDefault(); var fn = forms[e.target.dataset.form]; if (fn) fn(e.target); });
document.addEventListener('change', function (e) {
  var t = e.target;
  if (t.id === 'restore' && t.files && t.files[0]) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var o = JSON.parse(fr.result);
        if (!o || !Array.isArray(o.habits) || !Array.isArray(o.logs)) throw new Error('bad');
        S = {habits: o.habits, logs: o.logs}; save(); state.filter = 'all'; state.tab = 'today'; render(); window.scrollTo(0, 0);
      } catch (er) { msg('That file is not a Constellation backup.'); }
    };
    fr.readAsText(t.files[0]);
  }
});

if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}
loadSession();
mountBg();
render();
handleHash().then(function () { if (SB.session) syncNow(); else if (SB.err) render(true); });
window.addEventListener('hashchange', function () { handleHash().then(function () { if (SB.session) { SB.busy = false; syncNow(); } else render(true); }); });
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && SB.session && !SB.timer) { SB.busy = false; syncNow(); } });
})();
