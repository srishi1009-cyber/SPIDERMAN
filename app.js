/* RISHI MUSIC
   - Songs are copied into IndexedDB, so they stay even if you delete the original files.
   - Playback is random. A song played once today is marked "Played today" and is skipped
     by shuffle / next / auto-play until you tap it yourself (or press Reset today). */

'use strict';

/* ================= Database ================= */
const DB_NAME = 'rishi-music-db';
const STORE = 'songs';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbAll = () => tx('readonly', s => s.getAll());
const dbAdd = song => tx('readwrite', s => s.add(song));
const dbPut = song => tx('readwrite', s => s.put(song));
const dbDelete = id => tx('readwrite', s => s.delete(id));

/* ================= "Played today" memory ================= */
const PLAYED_KEY = 'rishi-played-v1';

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadPlayed() {
  try {
    const map = JSON.parse(localStorage.getItem(PLAYED_KEY) || '{}');
    const t = todayKey();
    Object.keys(map).forEach(k => { if (map[k] !== t) delete map[k]; });
    return map;
  } catch (e) { return {}; }
}

let playedMap = loadPlayed();

function savePlayed() {
  try { localStorage.setItem(PLAYED_KEY, JSON.stringify(playedMap)); } catch (e) {}
}

const isPlayedToday = id => playedMap[id] === todayKey();

/* ================= State ================= */
const UNKNOWN = 'Unknown Director';
const MARK_AFTER_SECONDS = 5;

let songs = [];
let queue = [];            // ids that shuffle is allowed to choose from (the list you started from)
let history = [];          // ids in the order they were played (for the Previous button)
let badIds = new Set();    // songs that failed to decode this session
let currentId = null;
let currentUrl = null;
let markedCurrent = false;
let editingId = null;
let seeking = false;
let failStreak = 0;
let stallTimer = null;

const audio = new Audio();
audio.preload = 'auto';

/* ================= Elements ================= */
const $ = id => document.getElementById(id);
const els = {
  list: $('songList'), empty: $('emptyMsg'), title: $('listTitle'), count: $('countLabel'),
  search: $('searchInput'), select: $('directorSelect'), playAll: $('playAllBtn'), reset: $('resetBtn'),
  importBtn: $('importBtn'), importModal: $('importModal'), importDirector: $('importDirector'),
  fileInput: $('fileInput'), importChoose: $('importChoose'), importCancel: $('importCancel'),
  importStatus: $('importStatus'),
  editModal: $('editModal'), editTitle: $('editTitle'), editDirector: $('editDirector'),
  editSave: $('editSave'), editCancel: $('editCancel'),
  dirList: $('directorList'),
  prev: $('prevBtn'), play: $('playBtn'), next: $('nextBtn'),
  seek: $('seek'), cur: $('curTime'), dur: $('durTime'),
  nowTitle: $('nowTitle'), nowSub: $('nowSub'), toast: $('toast')
};

/* ================= Helpers ================= */
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
}

function cleanName(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
}

function setRangeFill(pct) { els.seek.style.setProperty('--pct', pct + '%'); }

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
const directorOf = s => (s.director && s.director.trim()) || UNKNOWN;

function artStyle(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const hue = 190 + (h % 90);   // cyan -> blue -> violet
  return 'background:linear-gradient(135deg,hsl(' + hue + ' 90% 62%),hsl(' + (hue + 28) + ' 85% 38%))';
}

/* ================= Rendering ================= */
function directors() {
  return [...new Set(songs.map(directorOf))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function renderDirectorSelect() {
  const keep = els.select.value || '__all';
  els.select.innerHTML = '';
  els.select.add(new Option('ALL DIRECTORS', '__all'));
  directors().forEach(d => els.select.add(new Option(d.toUpperCase(), d)));
  els.select.value = [...els.select.options].some(o => o.value === keep) ? keep : '__all';

  els.dirList.innerHTML = '';
  directors().filter(d => d !== UNKNOWN).forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    els.dirList.appendChild(o);
  });
}

function visibleSongs() {
  const dir = els.select.value;
  const q = els.search.value.trim().toLowerCase();
  return songs
    .filter(s => dir === '__all' || directorOf(s) === dir)
    .filter(s => !q || s.title.toLowerCase().includes(q))
    .sort(byTitle);
}

function renderList() {
  const list = visibleSongs();
  const dir = els.select.value;
  const playedCount = list.filter(s => isPlayedToday(s.id)).length;

  els.title.textContent = dir === '__all' ? 'All Songs' : dir;
  els.count.textContent = list.length + (list.length === 1 ? ' song' : ' songs') +
    (playedCount ? ' \u00B7 ' + playedCount + ' played today' : '');
  els.reset.hidden = Object.keys(playedMap).length === 0;
  els.playAll.hidden = list.length === 0;
  els.empty.hidden = songs.length > 0;
  els.list.innerHTML = '';

  list.forEach(song => {
    const played = isPlayedToday(song.id);
    const li = document.createElement('li');
    li.className = 'song' + (song.id === currentId ? ' playing' : '') + (played ? ' played' : '');

    const art = document.createElement('div');
    art.className = 'art';
    art.setAttribute('style', artStyle(song.title));
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = (song.title.trim()[0] || '\u266B').toUpperCase();
    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.innerHTML = '<i></i><i></i><i></i>';
    art.append(letter, eq);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = song.title;
    const d = document.createElement('div');
    d.className = 'dir';
    d.textContent = directorOf(song);
    meta.append(name, d);
    if (played) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '\u2713 Played today';
      meta.appendChild(badge);
    }
    meta.addEventListener('click', () => playFromList(song.id));

    const edit = document.createElement('button');
    edit.className = 'pill-edit';
    edit.textContent = '\u270E Edit';
    edit.addEventListener('click', () => openEdit(song.id));

    const del = document.createElement('button');
    del.className = 'round del';
    del.setAttribute('aria-label', 'Delete');
    del.textContent = '\uD83D\uDDD1\uFE0F';
    del.addEventListener('click', () => removeSong(song.id));

    const go = document.createElement('button');
    go.className = 'round go';
    go.setAttribute('aria-label', 'Play');
    go.textContent = '\u25B6';
    go.addEventListener('click', () => playFromList(song.id));

    li.append(art, meta, edit, del, go);
    els.list.appendChild(li);
  });
}

function refresh() {
  renderDirectorSelect();
  renderList();
}

/* ================= Playback ================= */
function markPlayed(id) {
  if (id == null || isPlayedToday(id)) return;
  playedMap[id] = todayKey();
  savePlayed();
  renderList();
}

/* Tapping a song yourself always plays it, even if it was played today. */
function playFromList(id) {
  queue = visibleSongs().map(s => s.id);
  failStreak = 0;
  badIds.delete(id);
  playSong(id);
}

/* Random pick from the current list, skipping songs already played today. */
function pickRandom() {
  if (!queue.length) queue = visibleSongs().map(s => s.id);
  const alive = new Set(songs.map(s => s.id));
  const pool = queue.filter(id =>
    alive.has(id) && id !== currentId && !badIds.has(id) && !isPlayedToday(id));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function shufflePlay() {
  const list = visibleSongs();
  if (!list.length) return;
  queue = list.map(s => s.id);
  failStreak = 0;
  const id = pickRandom();
  if (id == null) {
    toast('Everything here is already played today. Tap a song to play it, or Reset today.');
    return;
  }
  playSong(id);
}

function playSong(id, fromHistory) {
  const song = songs.find(s => s.id === id);
  if (!song) return;

  clearTimeout(stallTimer);
  currentId = id;
  markedCurrent = isPlayedToday(id);

  if (!fromHistory && history[history.length - 1] !== id) {
    history.push(id);
    if (history.length > 200) history.shift();
  }

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(song.blob);
  audio.src = currentUrl;
  audio.load();
  const p = audio.play();
  if (p && p.catch) p.catch(() => updatePlayIcon());

  els.nowTitle.textContent = song.title;
  els.nowSub.textContent = directorOf(song);
  els.seek.value = 0;
  setRangeFill(0);
  els.cur.textContent = '0:00';
  els.dur.textContent = '0:00';
  document.body.classList.remove('is-idle');
  updateMediaSession(song);
  renderList();
}

/* auto = true when the previous song ended by itself */
function nextTrack(auto) {
  const id = pickRandom();
  if (id == null) {
    if (auto) {
      els.nowSub.textContent = 'All songs in this list are played today';
      updatePlayIcon();
    }
    toast('No more songs to shuffle. All are played today.');
    return;
  }
  playSong(id);
}

function prevTrack() {
  if (audio.currentTime > 3 || history.length < 2) { audio.currentTime = 0; return; }
  history.pop();                               // drop the current song
  playSong(history[history.length - 1], true); // go back to the one before it
}

function togglePlay() {
  if (!currentId) { shufflePlay(); return; }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function updatePlayIcon() {
  els.play.innerHTML = audio.paused ? '&#9654;' : '&#10074;&#10074;';
  document.body.classList.toggle('is-paused', audio.paused);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  }
}

audio.addEventListener('ended', () => {
  markPlayed(currentId);
  nextTrack(true);
});
audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('playing', () => {
  failStreak = 0;
  clearTimeout(stallTimer);
  updatePlayIcon();
});

/* Anti-stuck: if playback stalls for 5 seconds, reload from the same spot */
function recoverFromStall() {
  if (!currentId || audio.paused || audio.readyState >= 3) return;
  const t = audio.currentTime;
  audio.load();
  audio.addEventListener('loadedmetadata', function once() {
    audio.removeEventListener('loadedmetadata', once);
    try { audio.currentTime = t; } catch (e) {}
    audio.play().catch(() => {});
  });
}
['waiting', 'stalled'].forEach(evt => {
  audio.addEventListener(evt, () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(recoverFromStall, 5000);
  });
});

/* A broken file is skipped instead of stopping the music */
audio.addEventListener('error', () => {
  if (currentId == null) return;
  badIds.add(currentId);
  failStreak++;
  if (failStreak >= Math.max(queue.length, 1)) {
    toast('Could not play these songs. Try importing them again.');
    return;
  }
  toast('Skipping a track that would not play');
  setTimeout(() => nextTrack(true), 400);
});

audio.addEventListener('loadedmetadata', () => {
  els.dur.textContent = fmt(audio.duration);
  els.seek.max = isFinite(audio.duration) ? audio.duration : 100;
});

audio.addEventListener('timeupdate', () => {
  if (!markedCurrent && audio.currentTime >= MARK_AFTER_SECONDS) {
    markedCurrent = true;
    markPlayed(currentId);
  }
  if (seeking) return;
  els.cur.textContent = fmt(audio.currentTime);
  if (isFinite(audio.duration) && audio.duration > 0) {
    els.seek.value = audio.currentTime;
    setRangeFill((audio.currentTime / audio.duration) * 100);
  }
});

els.seek.addEventListener('input', () => {
  seeking = true;
  els.cur.textContent = fmt(els.seek.value);
  setRangeFill((els.seek.value / (parseFloat(els.seek.max) || 1)) * 100);
});
els.seek.addEventListener('change', () => {
  audio.currentTime = parseFloat(els.seek.value);
  seeking = false;
});

/* Lock-screen / notification controls */
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: directorOf(song),
    album: 'Rishi Music',
    artwork: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const safe = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) {} };
  safe('play', () => audio.play().catch(() => {}));
  safe('pause', () => audio.pause());
  safe('previoustrack', prevTrack);
  safe('nexttrack', () => nextTrack(false));
  safe('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ================= Import ================= */
function openImport() {
  els.importDirector.value = '';
  els.importStatus.hidden = true;
  els.importChoose.disabled = false;
  els.importCancel.disabled = false;
  els.importModal.hidden = false;
}
function closeImport() { els.importModal.hidden = true; }

async function importFiles(files) {
  const list = [...files].filter(f =>
    f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac|opus|weba)$/i.test(f.name));
  if (!list.length) { toast('No audio files selected'); return; }

  const director = els.importDirector.value.trim() || UNKNOWN;
  els.importChoose.disabled = true;
  els.importCancel.disabled = true;
  els.importStatus.hidden = false;

  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }

  let saved = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    els.importStatus.textContent = 'Saving ' + (i + 1) + ' of ' + list.length + '\u2026';
    try {
      const buffer = await f.arrayBuffer();   // real copy of the bytes
      const blob = new Blob([buffer], { type: f.type || 'audio/mpeg' });
      await dbAdd({ title: cleanName(f.name), director, blob, size: blob.size, added: Date.now() });
      saved++;
    } catch (err) {
      console.error('Import failed for', f.name, err);
      toast('Storage is full or blocked. Could not save ' + f.name);
      break;
    }
  }

  songs = await dbAll();
  refresh();
  closeImport();
  els.fileInput.value = '';
  if (saved) toast(saved + (saved === 1 ? ' song' : ' songs') + ' saved to your library');
}

/* ================= Edit / Delete ================= */
function openEdit(id) {
  const song = songs.find(s => s.id === id);
  if (!song) return;
  editingId = id;
  els.editTitle.value = song.title;
  els.editDirector.value = song.director === UNKNOWN ? '' : (song.director || '');
  els.editModal.hidden = false;
  els.editTitle.focus();
}

async function saveEdit() {
  const song = songs.find(s => s.id === editingId);
  if (!song) return;
  song.title = els.editTitle.value.trim() || song.title;
  song.director = els.editDirector.value.trim() || UNKNOWN;
  await dbPut(song);
  els.editModal.hidden = true;
  editingId = null;
  refresh();
  if (song.id === currentId) {
    els.nowTitle.textContent = song.title;
    els.nowSub.textContent = directorOf(song);
    updateMediaSession(song);
  }
  toast('Changes saved');
}

async function removeSong(id) {
  const song = songs.find(s => s.id === id);
  if (!song) return;
  if (!confirm('Delete "' + song.title + '" from Rishi Music?')) return;

  const wasCurrent = id === currentId;
  await dbDelete(id);
  songs = songs.filter(s => s.id !== id);
  queue = queue.filter(q => q !== id);
  history = history.filter(h => h !== id);
  delete playedMap[id];
  savePlayed();

  if (wasCurrent) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    currentId = null;
    els.nowTitle.textContent = 'No track playing';
    els.nowSub.textContent = 'Select a song from your library';
    els.seek.value = 0; setRangeFill(0);
    els.cur.textContent = '0:00'; els.dur.textContent = '0:00';
    document.body.classList.add('is-idle');
    updatePlayIcon();
    refresh();
    const nextId = pickRandom();
    if (nextId != null) playSong(nextId);
    return;
  }
  refresh();
  toast('Song deleted');
}

function resetToday() {
  playedMap = {};
  savePlayed();
  badIds.clear();
  renderList();
  toast('Cleared. All songs can shuffle again.');
}

/* ================= Wiring ================= */
els.importBtn.addEventListener('click', openImport);
els.importCancel.addEventListener('click', closeImport);
els.importChoose.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) importFiles(els.fileInput.files);
});

els.editCancel.addEventListener('click', () => { els.editModal.hidden = true; });
els.editSave.addEventListener('click', saveEdit);

[els.importModal, els.editModal].forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m && !els.importCancel.disabled) m.hidden = true;
  });
});

els.select.addEventListener('change', renderList);
els.search.addEventListener('input', renderList);
els.playAll.addEventListener('click', shufflePlay);
els.reset.addEventListener('click', resetToday);

els.play.addEventListener('click', togglePlay);
els.next.addEventListener('click', () => nextTrack(false));
els.prev.addEventListener('click', prevTrack);

/* A new day starts: refresh the "Played today" marks when you come back to the app */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { playedMap = loadPlayed(); savePlayed(); renderList(); }
});

/* ================= Start ================= */
(async function init() {
  try {
    db = await openDB();
    songs = await dbAll();
    refresh();
  } catch (err) {
    console.error(err);
    toast('Storage is not available in this browser');
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed', err));
  });
}