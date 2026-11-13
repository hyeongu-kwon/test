'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CFG = window.TV_CONFIG || {};
const configured = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);
const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

const state = {
  role: null, userId: null, videos: [], q: '', place: '', year: '',
  sort: localStorage.getItem('tv-sort') || 'new',
  currentId: null, editId: null, queue: [], uploading: false,
  thumbUrls: {}, mediaUrls: {},
};
const isAdmin = () => state.role === 'admin';

/* ---------- Supabase ---------- */
const ERRORS = [
  [/invalid login credentials/i, '아이디 또는 비밀번호가 맞지 않습니다.'],
  [/row-level security|not allowed|permission denied|unauthorized/i, '권한이 없습니다.'],
  [/exceeded the maximum allowed size|payload too large|too large/i, '파일이 Supabase 업로드 한도보다 큽니다. (무료 플랜은 파일당 50MB)'],
  [/mime type .* is not supported/i, 'MP4, MOV, WebM 영상과 JPG, PNG, WebP 이미지만 올릴 수 있습니다.'],
  [/failed to fetch|network/i, '네트워크 오류입니다. 잠시 뒤 다시 시도하세요.'],
  [/rate limit/i, '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.'],
  [/already exists/i, '이미 있는 아이디입니다.'],
  [/invalid email/i, '아이디는 영문·숫자로 입력하세요. (예: guest, mom2)'],
  [/password length/i, '비밀번호는 8~72자로 입력하세요.'],
  [/cannot (delete self|change own role)/i, '내 계정의 권한을 바꾸거나 삭제할 수는 없습니다.'],
  [/could not find the function|admin_\w+.*does not exist/i, '계정 관리 기능이 아직 설치되지 않았어요. 최신 setup.sql을 Supabase SQL Editor에서 실행하세요.'],
];
function friendly(err) {
  const msg = (err && (err.message || err.error_description || err.error)) || '요청에 실패했습니다.';
  const hit = ERRORS.find(([re]) => re.test(msg));
  return new Error(hit ? hit[1] : msg);
}
// Supabase 호출 결과에서 data만 꺼내고, 오류는 한국어 메시지로 던집니다.
async function run(promise) {
  const { data, error } = await promise;
  if (error) throw friendly(error);
  return data;
}
const fromRow = (r) => ({
  id: r.id, title: r.title, description: r.description, location: r.location, date: r.trip_date || '',
  tags: r.tags || [], featured: r.featured, duration: Number(r.duration) || 0,
  file: r.video_path, thumb: r.thumb_path, views: r.views || 0, createdAt: r.created_at,
});
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const fileExt = (name) => (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase();

// 진행률을 보여주기 위해 영상은 Storage REST API로 직접 올립니다.
async function uploadWithProgress(bucket, path, blob, contentType, onProgress) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('로그인이 필요합니다.');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${CFG.supabaseUrl}/storage/v1/object/${bucket}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', CFG.supabaseAnonKey);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('Cache-Control', 'max-age=3600');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(friendly(xhr.status === 413 ? { message: 'payload too large' } : data));
    };
    xhr.onerror = () => reject(friendly({ message: 'network' }));
    xhr.send(blob);
  });
}
async function uploadThumb(id, blob) {
  const ext = { 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg';
  const path = `${id}-${Date.now()}.${ext}`;
  await run(sb.storage.from('thumbs').upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000' }));
  await signThumbs([path]);
  return path;
}
async function signThumbs(paths) {
  paths = paths.filter((p) => p && !state.thumbUrls[p]);
  if (!paths.length) return;
  const signed = await run(sb.storage.from('thumbs').createSignedUrls(paths, 7 * 86400));
  for (const s of signed) if (s.signedUrl) state.thumbUrls[s.path] = s.signedUrl;
}
// 영상은 비공개 버킷에 있어서, 재생할 때마다 1시간짜리 서명 주소를 받아 씁니다.
async function mediaUrl(v) {
  const hit = state.mediaUrls[v.file];
  if (hit && hit.exp > Date.now()) return hit.url;
  const { signedUrl } = await run(sb.storage.from('videos').createSignedUrl(v.file, 3600));
  state.mediaUrls[v.file] = { url: signedUrl, exp: Date.now() + 50 * 60e3 };
  return signedUrl;
}

/* ---------- 표시 형식 ---------- */
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${y}년 ${m}월 ${day}일`;
}
const metaLine = (v) => [v.location, fmtDate(v.date), `조회 ${(v.views || 0).toLocaleString('ko-KR')}`].filter(Boolean).join(' · ');
const thumbUrl = (v) => (v.thumb && state.thumbUrls[v.thumb]) || '';
const parseTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);
const sortKeyDate = (v) => v.date || (v.createdAt || '').slice(0, 10);
const displayId = (email) => (email || '').replace(new RegExp(`@${(CFG.loginDomain || '').replace(/\./g, '\\.')}$`), '');

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- 로그인 ---------- */
function setTitle(title) {
  if (!title) return;
  document.title = title;
  $$('[data-site-title]').forEach((el) => { el.textContent = title; });
}
function showLogin(notice = '') {
  state.role = null; state.userId = null;
  $$('dialog[open]').forEach((d) => d.close());
  $('#app').hidden = true; $('#login').hidden = false;
  document.body.classList.remove('is-admin');
  const n = $('#login-notice'); n.hidden = !notice; n.textContent = notice;
  $('#login-form').elements.id.focus();
}
// 로그인된 계정의 권한을 확인하고 들어갑니다. 권한이 없으면 로그아웃시킵니다.
async function enter(user) {
  const profile = await run(sb.from('profiles').select('role').eq('id', user.id).maybeSingle());
  const role = profile && profile.role;
  if (role !== 'admin' && role !== 'guest') {
    await sb.auth.signOut();
    return showLogin('이 계정은 아직 볼 수 있는 권한이 없어요. 관리자에게 권한을 요청하세요.');
  }
  state.role = role; state.userId = user.id;
  document.body.classList.toggle('is-admin', isAdmin());
  $('#login').hidden = true; $('#app').hidden = false;
  await loadVideos();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget, err = $('#login-error'), btn = $('button[type=submit]', f);
  err.textContent = ''; $('#login-notice').hidden = true; btn.disabled = true;
  try {
    const id = f.elements.id.value.trim();
    const { user } = await run(sb.auth.signInWithPassword({ email: toEmail(id), password: f.elements.password.value }));
    f.reset(); await enter(user);
  } catch (ex) { err.textContent = ex.message; f.elements.password.select(); }
  finally { btn.disabled = false; }
});
$('#btn-logout').addEventListener('click', async () => { await sb.auth.signOut().catch(() => {}); showLogin(); });

/* ---------- 목록 ---------- */
async function loadVideos() {
  state.videos = (await run(sb.from('videos').select('*'))).map(fromRow);
  await signThumbs(state.videos.map((v) => v.thumb)).catch(() => {});
  render();
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  const list = state.videos.filter((v) => {
    if (state.place && v.location !== state.place) return false;
    if (state.year && sortKeyDate(v).slice(0, 4) !== state.year) return false;
    if (q && ![v.title, v.description, v.location, ...(v.tags || [])].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    new: (a, b) => sortKeyDate(b).localeCompare(sortKeyDate(a)) || b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => sortKeyDate(a).localeCompare(sortKeyDate(b)) || a.createdAt.localeCompare(b.createdAt),
    added: (a, b) => b.createdAt.localeCompare(a.createdAt),
    views: (a, b) => (b.views || 0) - (a.views || 0),
    title: (a, b) => a.title.localeCompare(b.title, 'ko'),
  }[state.sort];
  return list.sort(by);
}

function render() {
  const all = state.videos, playable = all.filter((v) => v.file);

  // 대표 영상: 고정한 영상이 있으면 그중 최신, 없으면 가장 최근 여행
  const hero = $('#hero');
  const byNew = [...playable].sort((a, b) => sortKeyDate(b).localeCompare(sortKeyDate(a)) || b.createdAt.localeCompare(a.createdAt));
  const feat = byNew.find((v) => v.featured) || byNew[0];
  hero.hidden = !feat;
  // 검색·필터로 다시 그릴 때 배경 영상이 처음부터 재시작하지 않도록, 내용이 바뀐 경우에만 새로 만듭니다.
  const heroKey = feat ? JSON.stringify([feat.id, feat.featured, feat.title, feat.location, feat.date, feat.duration, feat.description, feat.thumb]) : '';
  if (hero.dataset.key !== heroKey) {
    hero.dataset.key = heroKey;
    hero.dataset.id = feat ? feat.id : '';
    hero.innerHTML = !feat ? '' : `
      <div class="hero-bg"></div>
      <div class="hero-body">
        <span class="hero-kicker">${feat.featured ? '대표 영상' : '최근 여행'}</span>
        <h1 class="hero-title">${esc(feat.title)}</h1>
        <p class="hero-meta">${esc([feat.location, fmtDate(feat.date), fmtDuration(feat.duration)].filter(Boolean).join(' · '))}</p>
        ${feat.description ? `<p class="hero-desc">${esc(feat.description)}</p>` : ''}
        <button class="btn primary" type="button">▶ 재생</button>
      </div>`;
    if (feat && feat.thumb) $('.hero-bg', hero).style.backgroundImage = `url("${thumbUrl(feat)}")`;
    if (feat) startHeroVideo(feat, heroKey);
  }

  // 요약
  const totalSec = playable.reduce((s, v) => s + (v.duration || 0), 0);
  const hrs = Math.floor(totalSec / 3600), mins = Math.round((totalSec % 3600) / 60);
  const places = new Map();
  for (const v of all) if (v.location) places.set(v.location, (places.get(v.location) || 0) + 1);
  const views = all.reduce((s, v) => s + (v.views || 0), 0);
  $('#stats').innerHTML = [
    ['영상', `${playable.length}<small>편</small>`],
    ['총 재생시간', hrs ? `${hrs}<small>시간</small> ${mins}<small>분</small>` : totalSec >= 60 || !totalSec ? `${mins}<small>분</small>` : `${Math.round(totalSec)}<small>초</small>`],
    ['여행지', `${places.size}<small>곳</small>`],
    ['총 조회수', `${views.toLocaleString('ko-KR')}<small>회</small>`],
  ].map(([label, value]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value num">${value}</div></div>`).join('');

  // 필터
  if (state.place && !places.has(state.place)) state.place = '';
  const placeList = [...places].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  $('#places').innerHTML = [['', '전체', all.length], ...placeList.map(([name, n]) => [name, name, n])]
    .map(([value, label, n]) => `<button class="chip" role="tab" type="button" data-place="${esc(value)}" aria-selected="${state.place === value}">${esc(label)}<span class="count">${n}</span></button>`).join('');
  $('#location-list').innerHTML = placeList.map(([name]) => `<option value="${esc(name)}">`).join('');

  const years = [...new Set(all.map((v) => sortKeyDate(v).slice(0, 4)).filter(Boolean))].sort().reverse();
  if (state.year && !years.includes(state.year)) state.year = '';
  $('#year').innerHTML = `<option value="">모든 연도</option>` + years.map((y) => `<option value="${y}">${y}년</option>`).join('');
  $('#year').value = state.year;
  $('#sort').value = state.sort;

  // 카드
  const list = filtered();
  const gridHtml = list.map((v) => `
    <div class="card" role="button" tabindex="0" data-id="${v.id}">
      <div class="card-thumb">
        ${v.thumb ? `<img src="${thumbUrl(v)}" alt="" loading="lazy">` : '<div class="placeholder">▶</div>'}
        ${v.featured ? '<span class="badge left">대표</span>' : ''}
        ${v.file ? `<span class="badge">${fmtDuration(v.duration)}</span>` : '<span class="badge warn">업로드 미완료</span>'}
      </div>
      <div>
        <div class="card-title">${esc(v.title)}</div>
        <div class="card-meta">${esc(metaLine(v))}</div>
      </div>
      ${isAdmin() ? '<button class="card-edit" type="button" data-edit>수정</button>' : ''}
    </div>`).join('');
  // 내용이 그대로면 다시 만들지 않습니다.
  if (gridHtml !== lastGridHtml) {
    lastGridHtml = gridHtml;
    $('#grid').innerHTML = gridHtml;
  }

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = all.length
      ? '<strong>조건에 맞는 영상이 없어요</strong><span>검색어나 필터를 바꿔 보세요.</span>'
      : `<strong>아직 영상이 없어요</strong><span>${isAdmin() ? '첫 여행 영상을 올려 보세요.' : '곧 새 영상이 올라올 거예요.'}</span>` +
        (isAdmin() ? '<button class="btn primary" type="button" data-open-upload>＋ 영상 업로드</button>' : '');
  }
}

// 첫 화면 배경에서 대표 영상을 소리 없이 반복 재생합니다. (재생이 막히면 썸네일이 그대로 보입니다)
async function startHeroVideo(v, key) {
  if (reduceMotion) return;
  const src = await mediaUrl(v).catch(() => null);
  const hero = $('#hero'), bg = $('.hero-bg', hero);
  if (!src || !bg || hero.dataset.key !== key) return;
  const el = makeSilentVideo(src, 'hero-video');
  el.dataset.visible = '1';
  bg.after(el);
  if (!player.open) el.play().catch(() => {});
}
const heroVideo = () => $('#hero .hero-video');

$('#search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
$('#year').addEventListener('change', (e) => { state.year = e.target.value; render(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; localStorage.setItem('tv-sort', state.sort); render(); });
$('#places').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-place]'); if (!chip) return;
  state.place = chip.dataset.place; render();
});
$('#hero').addEventListener('click', () => openPlayer($('#hero').dataset.id));
$('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-open-upload]')) openUpload(); });

const grid = $('#grid');
function activateCard(e) {
  const card = e.target.closest('.card'); if (!card) return;
  const v = state.videos.find((x) => x.id === card.dataset.id);
  if (e.target.closest('[data-edit]') || !v.file) { if (isAdmin()) openEdit(v.id); return; }
  openPlayer(v.id);
}
grid.addEventListener('click', activateCard);
grid.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) { e.preventDefault(); activateCard(e); }
});

// 자동 재생은 맨 위 대표 영상만 합니다. 카드는 마우스를 올렸을 때만 소리 없이 미리보기를 보여줍니다.
let lastGridHtml = null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover)').matches;
const backgroundVideos = () => $$('#hero .hero-video, #grid .card-thumb video');
const pauseBackground = () => { stopPreview(); backgroundVideos().forEach((el) => el.pause()); };
function resumeBackground() {
  backgroundVideos().forEach((el) => { if (el.dataset.visible === '1') el.play().catch(() => {}); });
}
function makeSilentVideo(src, className) {
  const el = document.createElement('video');
  el.className = className;
  el.muted = true; el.defaultMuted = true; el.loop = true; el.playsInline = true;
  el.setAttribute('muted', ''); el.setAttribute('playsinline', ''); el.setAttribute('aria-hidden', 'true');
  el.addEventListener('playing', () => el.classList.add('on'), { once: true });
  el.addEventListener('error', () => el.remove());
  el.src = src;
  return el;
}
let previewTimer = null;
function stopPreview() {
  clearTimeout(previewTimer); previewTimer = null;
  const el = $('.card-thumb video', grid);
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
}
grid.addEventListener('mouseover', (e) => {
  if (!canHover) return;
  const card = e.target.closest('.card');
  if (!card || card.contains(e.relatedTarget)) return;
  stopPreview();
  const v = state.videos.find((x) => x.id === card.dataset.id);
  if (!v || !v.file) return;
  const timer = previewTimer = setTimeout(async () => {
    const src = await mediaUrl(v).catch(() => null);
    if (!src || timer !== previewTimer || !card.isConnected) return;
    const el = makeSilentVideo(src, '');
    $('.card-thumb', card).append(el);
    el.play().catch(() => el.remove());
  }, 600);
});
grid.addEventListener('mouseout', (e) => {
  const card = e.target.closest('.card');
  if (card && !card.contains(e.relatedTarget)) stopPreview();
});
// 대표 영상은 화면 밖으로 나가면 잠시 멈춥니다.
if (!reduceMotion) {
  new IntersectionObserver(([entry]) => {
    const el = heroVideo(); if (!el) return;
    el.dataset.visible = entry.isIntersecting ? '1' : '';
    if (entry.isIntersecting && !player.open) el.play().catch(() => {}); else el.pause();
  }, { threshold: 0.25 }).observe($('#hero'));
}

/* ---------- 대화상자 공통 ---------- */
$$('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

/* ---------- 플레이어 ---------- */
const player = $('#player'), pv = $('#player-video');
pv.crossOrigin = 'anonymous'; // 다른 출처(Supabase)의 영상에서 썸네일을 뽑으려면 필요
const autoNext = $('#autoplay-next');
autoNext.checked = localStorage.getItem('tv-autonext') !== '0';
autoNext.addEventListener('change', () => localStorage.setItem('tv-autonext', autoNext.checked ? '1' : '0'));

function neighbors(id) {
  const list = filtered().filter((v) => v.file);
  const i = list.findIndex((v) => v.id === id);
  return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}
function fillPlayer(v) {
  $('#player-title').textContent = v.title;
  $('#player-meta').textContent = metaLine(v);
  $('#player-desc').textContent = v.description || '';
  $('#player-tags').innerHTML = (v.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
  const { prev, next } = neighbors(v.id);
  $('#player-prev').disabled = !prev; $('#player-next').disabled = !next;
}
async function openPlayer(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v || !v.file) return;
  pauseBackground();
  state.currentId = id;
  fillPlayer(v);
  pv.poster = thumbUrl(v);
  if (!player.open) player.showModal();
  try {
    const src = await mediaUrl(v);
    if (state.currentId !== id) return;
    pv.src = src;
    pv.play().catch(() => {});
  } catch (ex) { return toast(ex.message); }
  run(sb.rpc('increment_views', { video_id: id }))
    .then((n) => { v.views = n; if (state.currentId === id) $('#player-meta').textContent = metaLine(v); }).catch(() => {});
}
function step(dir) {
  const target = neighbors(state.currentId)[dir];
  if (target) openPlayer(target.id);
}
$('#player-prev').addEventListener('click', () => step('prev'));
$('#player-next').addEventListener('click', () => step('next'));
// CORS 문제로 재생이 안 되면 일반 모드로 한 번 더 시도합니다. (이 경우 "지금 장면을 썸네일로"만 쓸 수 없음)
pv.addEventListener('error', () => {
  if (pv.crossOrigin === null || !pv.currentSrc) return;
  const src = pv.currentSrc;
  pv.removeAttribute('crossorigin'); pv.src = src; pv.play().catch(() => {});
});
pv.addEventListener('ended', () => { if (autoNext.checked) step('next'); });
player.addEventListener('close', () => {
  pv.pause(); pv.removeAttribute('src'); pv.load();
  state.currentId = null; render();
  resumeBackground();
});
$('#player-edit').addEventListener('click', () => { const id = state.currentId; player.close(); openEdit(id); });
$('#player-thumb').addEventListener('click', async () => {
  const v = state.videos.find((x) => x.id === state.currentId);
  try {
    const blob = await captureFrame(pv);
    if (!blob) throw new Error('이 장면은 썸네일로 만들 수 없어요.');
    await setThumb(v, blob); toast('썸네일을 바꿨어요');
  } catch (ex) { toast(ex.message); }
});
async function setThumb(v, blob) {
  const old = v.thumb;
  const path = await uploadThumb(v.id, blob);
  replaceVideo(fromRow(await run(sb.from('videos').update({ thumb_path: path }).eq('id', v.id).select().single())));
  if (old) sb.storage.from('thumbs').remove([old]);
}
function replaceVideo(video) {
  const i = state.videos.findIndex((v) => v.id === video.id);
  if (i >= 0) state.videos[i] = video; else state.videos.push(video);
}

/* ---------- 영상 분석 (길이·썸네일) ---------- */
function captureFrame(videoEl) {
  return new Promise((resolve) => {
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return resolve(null);
    const scale = Math.min(1, 1280 / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    try {
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
    } catch { resolve(null); }
  });
}
function probe(file) {
  return new Promise((resolve) => {
    const out = { duration: 0, width: 0, height: 0, thumb: null };
    const el = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); resolve(out);
    };
    const timer = setTimeout(finish, 12000);
    el.muted = true; el.playsInline = true; el.preload = 'auto';
    el.onloadedmetadata = () => {
      out.duration = Number.isFinite(el.duration) ? el.duration : 0;
      out.width = el.videoWidth; out.height = el.videoHeight;
      el.currentTime = Math.min(out.duration * 0.25, 15) || 0.1;
    };
    el.onseeked = async () => { out.thumb = await captureFrame(el); finish(); };
    el.onerror = finish;
    el.src = url;
  });
}

/* ---------- 업로드 ---------- */
const uploadDlg = $('#upload'), uploadForm = $('#upload-form'), queueEl = $('#queue'), drop = $('#drop');
function openUpload() {
  if (!state.uploading) { state.queue = []; uploadForm.reset(); $('#upload-error').textContent = ''; renderQueue(); }
  uploadDlg.showModal();
}
$('#btn-upload').addEventListener('click', openUpload);

function renderQueue() {
  queueEl.innerHTML = state.queue.map((q, i) => `
    <li data-i="${i}">
      <div class="q-thumb"></div>
      <div class="q-main">
        <input value="${esc(q.title)}" maxlength="120" aria-label="제목" ${q.status !== 'ready' ? 'disabled' : ''}>
        ${q.status === 'uploading' ? `<progress max="1" value="${q.progress}"></progress>` : ''}
        <span class="q-status ${q.status === 'error' ? 'bad' : q.status === 'done' ? 'ok' : ''}">${esc(q.message)}</span>
      </div>
      ${q.status === 'ready' || q.status === 'error' ? '<button class="icon-btn" type="button" data-remove aria-label="목록에서 빼기">✕</button>' : '<span></span>'}
    </li>`).join('');
  $$('li', queueEl).forEach((li, i) => {
    const q = state.queue[i];
    if (q.thumbUrl) $('.q-thumb', li).style.backgroundImage = `url("${q.thumbUrl}")`;
  });
  $('#upload-submit').disabled = state.uploading || !state.queue.some((q) => q.status === 'ready');
}
async function addFiles(files) {
  for (const file of files) {
    if (!VIDEO_TYPES[fileExt(file.name)]) { toast(`${file.name}: MP4, MOV, WebM만 올릴 수 있어요`); continue; }
    const q = {
      file, title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(),
      status: 'analyzing', message: '분석 중…', progress: 0, info: null, thumbUrl: '',
    };
    state.queue.push(q); renderQueue();
    q.info = await probe(file);
    if (q.info.thumb) q.thumbUrl = URL.createObjectURL(q.info.thumb);
    q.status = 'ready';
    q.message = `${(file.size / 1048576).toFixed(1)}MB` + (q.info.duration ? ` · ${fmtDuration(q.info.duration)}` : ' · 미리보기를 만들 수 없는 형식 (업로드는 가능)');
    renderQueue();
  }
  const dateInput = uploadForm.elements.date;
  if (!dateInput.value && files[0]) {
    const d = new Date(files[0].lastModified);
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
$('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
queueEl.addEventListener('input', (e) => { const li = e.target.closest('li'); if (li) state.queue[li.dataset.i].title = e.target.value; });
queueEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li && e.target.closest('[data-remove]')) { state.queue.splice(Number(li.dataset.i), 1); renderQueue(); }
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.uploading) return;
  state.uploading = true;
  const f = uploadForm.elements;
  const shared = { location: f.location.value, date: f.date.value, tags: parseTags(f.tags.value) };
  let failed = 0;
  for (const q of state.queue) {
    if (q.status !== 'ready') continue;
    q.status = 'uploading'; q.message = '업로드 중… 0%'; renderQueue();
    const id = crypto.randomUUID(), ext = fileExt(q.file.name);
    const videoPath = `${id}.${ext}`;
    let thumbPath = null, uploaded = false;
    try {
      let last = 0;
      await uploadWithProgress('videos', videoPath, q.file, VIDEO_TYPES[ext] || q.file.type, (p) => {
        q.progress = p; q.message = `업로드 중… ${Math.round(p * 100)}%`;
        if (p - last > 0.01 || p === 1) { last = p; renderQueue(); }
      });
      uploaded = true;
      if (q.info.thumb) thumbPath = await uploadThumb(id, q.info.thumb).catch(() => null);
      const row = await run(sb.from('videos').insert({
        id, title: q.title.trim() || '제목 없음', location: shared.location.trim(), trip_date: shared.date || null, tags: shared.tags,
        duration: Math.round((q.info.duration || 0) * 10) / 10, width: q.info.width || 0, height: q.info.height || 0,
        video_path: videoPath, thumb_path: thumbPath,
      }).select().single());
      replaceVideo(fromRow(row));
      q.status = 'done'; q.message = '완료';
    } catch (ex) {
      failed++; q.status = 'error'; q.message = ex.message;
      if (uploaded) sb.storage.from('videos').remove([videoPath]);
      if (thumbPath) sb.storage.from('thumbs').remove([thumbPath]);
    }
    renderQueue(); render();
  }
  state.uploading = false; renderQueue();
  if (!failed) { uploadDlg.close(); toast('업로드를 마쳤어요'); }
  else $('#upload-error').textContent = `${failed}개 영상을 올리지 못했어요.`;
});
window.addEventListener('beforeunload', (e) => { if (state.uploading) e.preventDefault(); });

/* ---------- 수정 ---------- */
const editDlg = $('#edit'), editForm = $('#edit-form');
function openEdit(id) {
  const v = state.videos.find((x) => x.id === id); if (!v) return;
  state.editId = id;
  const f = editForm.elements;
  editForm.reset(); $('#edit-error').textContent = '';
  f.title.value = v.title; f.description.value = v.description || ''; f.location.value = v.location || '';
  f.date.value = v.date || ''; f.tags.value = (v.tags || []).join(', '); f.featured.checked = Boolean(v.featured);
  editDlg.showModal();
}
editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = editForm.elements, id = state.editId;
  try {
    const row = await run(sb.from('videos').update({
      title: f.title.value.trim(), description: f.description.value.trim(), location: f.location.value.trim(),
      trip_date: f.date.value || null, tags: parseTags(f.tags.value), featured: f.featured.checked,
    }).eq('id', id).select().single());
    replaceVideo(fromRow(row));
    if (f.thumb.files[0]) await setThumb(state.videos.find((x) => x.id === id), f.thumb.files[0]);
    render(); editDlg.close(); toast('저장했어요');
  } catch (ex) { $('#edit-error').textContent = ex.message; }
});
$('#edit-delete').addEventListener('click', async () => {
  const v = state.videos.find((x) => x.id === state.editId);
  if (!v || !confirm(`"${v.title}" 영상을 삭제할까요?\n영상 파일도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    await run(sb.from('videos').delete().eq('id', v.id));
    await Promise.all([
      sb.storage.from('videos').remove([v.file]),
      v.thumb ? sb.storage.from('thumbs').remove([v.thumb]) : null,
    ]);
    state.videos = state.videos.filter((x) => x.id !== v.id);
    render(); editDlg.close(); toast('삭제했어요');
  } catch (ex) { $('#edit-error').textContent = ex.message; }
});

/* ---------- 계정과 권한 ---------- */
const ROLE_LABEL = { admin: '관리자', guest: '게스트', pending: '권한 없음' };
const toEmail = (id) => (id.includes('@') ? id : `${id}@${CFG.loginDomain}`).toLowerCase();
async function renderAccounts() {
  const list = await run(sb.from('profiles').select('id, email, role').order('created_at'));
  $('#accounts').innerHTML = list.map((p) => {
    const me = p.id === state.userId, name = esc(displayId(p.email));
    return `
    <li data-id="${p.id}" data-name="${name}">
      <span class="who">${name}${me ? ' <span class="muted">(나)</span>' : ''}</span>
      <select aria-label="${name} 권한" ${me ? 'disabled' : ''}>
        ${Object.entries(ROLE_LABEL).map(([value, label]) => `<option value="${value}" ${p.role === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${me ? '' : '<button class="btn ghost" type="button" data-act="password">비밀번호</button><button class="btn danger" type="button" data-act="delete">삭제</button>'}
    </li>`;
  }).join('');
}
function accountsMsg(text, bad = false) {
  const msg = $('#accounts-msg'); msg.className = bad ? 'form-msg bad' : 'form-msg'; msg.textContent = text;
}
$('#btn-settings').addEventListener('click', async () => {
  try {
    accountsMsg('');
    for (const sel of ['#password-form', '#create-form']) { $(sel).reset(); $('.form-msg', $(sel)).textContent = ''; }
    await renderAccounts(); $('#settings').showModal();
  } catch (ex) { toast(ex.message); }
});
$('#accounts').addEventListener('change', async (e) => {
  const li = e.target.closest('li[data-id]'); if (!li || e.target.tagName !== 'SELECT') return;
  try {
    await run(sb.from('profiles').update({ role: e.target.value }).eq('id', li.dataset.id).select().single());
    accountsMsg(`${li.dataset.name}: 권한을 "${ROLE_LABEL[e.target.value]}"(으)로 바꿨어요.`);
  } catch (ex) { accountsMsg(ex.message, true); await renderAccounts().catch(() => {}); }
});
$('#accounts').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const { id, name } = btn.closest('li').dataset;
  try {
    if (btn.dataset.act === 'password') {
      const pw = prompt(`"${name}" 계정의 새 비밀번호 (8자 이상)`);
      if (pw === null) return;
      await run(sb.rpc('admin_set_password', { p_user: id, p_password: pw }));
      accountsMsg(`${name}: 비밀번호를 바꿨어요.`);
    } else {
      if (!confirm(`"${name}" 계정을 삭제할까요? 이 계정으로는 더 이상 로그인할 수 없습니다.`)) return;
      await run(sb.rpc('admin_delete_user', { p_user: id }));
      await renderAccounts(); accountsMsg(`${name}: 계정을 삭제했어요.`);
    }
  } catch (ex) { accountsMsg(ex.message, true); }
});
$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, f = form.elements, msg = $('.form-msg', form);
  msg.className = 'form-msg';
  try {
    const id = f.id.value.trim();
    await run(sb.rpc('admin_create_user', { p_email: toEmail(id), p_password: f.password.value, p_role: f.role.value }));
    msg.textContent = `"${id}" 계정을 만들었어요. 아이디와 비밀번호를 알려주세요.`;
    form.reset(); await renderAccounts();
  } catch (ex) { msg.className = 'form-msg bad'; msg.textContent = ex.message; }
});
$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, msg = $('.form-msg', form);
  msg.className = 'form-msg';
  try {
    await run(sb.auth.updateUser({ password: form.elements.password.value }));
    form.reset(); msg.textContent = '비밀번호를 바꿨어요.';
  } catch (ex) { msg.className = 'form-msg bad'; msg.textContent = ex.message; }
});

/* ---------- 시작 ---------- */
(async () => {
  setTitle(CFG.siteTitle);
  if (!configured) {
    showLogin('아직 Supabase가 연결되지 않았어요. config.js에 프로젝트 URL과 anon 키를 넣어 주세요.');
    $$('#login-form input, #login-form button').forEach((el) => { el.disabled = true; });
    return;
  }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await enter(session.user); else showLogin();
  } catch (ex) { showLogin(ex.message); }
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && state.role) showLogin(); });
})();
