'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  role: null, videos: [], q: '', place: '', year: '',
  sort: localStorage.getItem('tv-sort') || 'new',
  currentId: null, editId: null, queue: [], uploading: false,
};
const isAdmin = () => state.role === 'admin';

/* ---------- API ---------- */
async function api(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'tv' }, credentials: 'same-origin' };
  if (body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error(data.error || '로그인이 필요합니다.'); }
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}
function uploadWithProgress(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'tv');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || '업로드에 실패했습니다.'));
    };
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드하지 못했습니다.'));
    xhr.send(blob);
  });
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
const thumbUrl = (v) => (v.thumb ? `/thumb/${v.id}?v=${v.thumbVer}` : '');
const parseTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);
const sortKeyDate = (v) => v.date || (v.createdAt || '').slice(0, 10);

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
function showLogin() {
  state.role = null;
  $$('dialog[open]').forEach((d) => d.close());
  $('#app').hidden = true; $('#login').hidden = false;
  document.body.classList.remove('is-admin');
  $('#login-form').elements.id.focus();
}
async function enter(role) {
  state.role = role;
  document.body.classList.toggle('is-admin', isAdmin());
  $('#login').hidden = true; $('#app').hidden = false;
  await loadVideos();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget, err = $('#login-error'), btn = $('button[type=submit]', f);
  err.textContent = ''; btn.disabled = true;
  try {
    const me = await api('POST', '/api/login', { id: f.elements.id.value, password: f.elements.password.value });
    f.reset(); setTitle(me.title); await enter(me.role);
  } catch (ex) { err.textContent = ex.message; f.elements.password.select(); }
  finally { btn.disabled = false; }
});
$('#btn-logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); showLogin(); });

/* ---------- 목록 ---------- */
async function loadVideos() {
  state.videos = (await api('GET', '/api/videos')).videos;
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
  if (feat) {
    hero.dataset.id = feat.id;
    hero.innerHTML = `
      <div class="hero-bg"></div>
      <div class="hero-body">
        <span class="hero-kicker">${feat.featured ? '대표 영상' : '최근 여행'}</span>
        <h1 class="hero-title">${esc(feat.title)}</h1>
        <p class="hero-meta">${esc([feat.location, fmtDate(feat.date), fmtDuration(feat.duration)].filter(Boolean).join(' · '))}</p>
        ${feat.description ? `<p class="hero-desc">${esc(feat.description)}</p>` : ''}
        <button class="btn primary" type="button">▶ 재생</button>
      </div>`;
    if (feat.thumb) $('.hero-bg', hero).style.backgroundImage = `url("${thumbUrl(feat)}")`;
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
  $('#grid').innerHTML = list.map((v) => `
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

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = all.length
      ? '<strong>조건에 맞는 영상이 없어요</strong><span>검색어나 필터를 바꿔 보세요.</span>'
      : `<strong>아직 영상이 없어요</strong><span>${isAdmin() ? '첫 여행 영상을 올려 보세요.' : '곧 새 영상이 올라올 거예요.'}</span>` +
        (isAdmin() ? '<button class="btn primary" type="button" data-open-upload>＋ 영상 업로드</button>' : '');
  }
}

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

// 마우스를 올리면 소리 없이 미리보기
let previewTimer;
const canHover = matchMedia('(hover: hover)').matches;
function stopPreview() {
  clearTimeout(previewTimer);
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
  previewTimer = setTimeout(() => {
    const el = document.createElement('video');
    el.muted = true; el.loop = true; el.playsInline = true; el.src = `/media/${v.id}`;
    $('.card-thumb', card).append(el);
    el.play().catch(() => el.remove());
  }, 600);
});
grid.addEventListener('mouseout', (e) => {
  const card = e.target.closest('.card');
  if (card && !card.contains(e.relatedTarget)) stopPreview();
});

/* ---------- 대화상자 공통 ---------- */
$$('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

/* ---------- 플레이어 ---------- */
const player = $('#player'), pv = $('#player-video');
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
function openPlayer(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v || !v.file) return;
  stopPreview();
  state.currentId = id;
  fillPlayer(v);
  pv.poster = thumbUrl(v);
  pv.src = `/media/${v.id}`;
  if (!player.open) player.showModal();
  pv.play().catch(() => {});
  api('POST', `/api/videos/${v.id}/view`).then((r) => { v.views = r.views; if (state.currentId === id) $('#player-meta').textContent = metaLine(v); }).catch(() => {});
}
function step(dir) {
  const target = neighbors(state.currentId)[dir];
  if (target) openPlayer(target.id);
}
$('#player-prev').addEventListener('click', () => step('prev'));
$('#player-next').addEventListener('click', () => step('next'));
pv.addEventListener('ended', () => { if (autoNext.checked) step('next'); });
player.addEventListener('close', () => {
  pv.pause(); pv.removeAttribute('src'); pv.load();
  state.currentId = null; render();
});
$('#player-edit').addEventListener('click', () => { const id = state.currentId; player.close(); openEdit(id); });
$('#player-thumb').addEventListener('click', async () => {
  const id = state.currentId;
  try {
    const blob = await captureFrame(pv);
    if (!blob) throw new Error('이 장면은 썸네일로 만들 수 없어요.');
    const { video } = await api('PUT', `/api/videos/${id}/thumb`, blob);
    replaceVideo(video); toast('썸네일을 바꿨어요');
  } catch (ex) { toast(ex.message); }
});
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
    if (!/^video\//.test(file.type) && !/\.(mp4|m4v|mov|webm)$/i.test(file.name)) { toast(`${file.name}: 영상 파일이 아니에요`); continue; }
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
    let created = null;
    try {
      const meta = { ...shared, title: q.title, duration: q.info.duration, width: q.info.width, height: q.info.height };
      created = (await api('POST', '/api/videos', meta)).video;
      let last = 0;
      let { video } = await uploadWithProgress(`/api/videos/${created.id}/file`, q.file, (p) => {
        q.progress = p; q.message = `업로드 중… ${Math.round(p * 100)}%`;
        if (p - last > 0.01 || p === 1) { last = p; renderQueue(); }
      });
      if (q.info.thumb) video = (await api('PUT', `/api/videos/${created.id}/thumb`, q.info.thumb)).video;
      replaceVideo(video);
      q.status = 'done'; q.message = '완료';
    } catch (ex) {
      failed++; q.status = 'error'; q.message = ex.message;
      if (created) api('DELETE', `/api/videos/${created.id}`).catch(() => {});
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
    let { video } = await api('PATCH', `/api/videos/${id}`, {
      title: f.title.value, description: f.description.value, location: f.location.value,
      date: f.date.value, tags: parseTags(f.tags.value), featured: f.featured.checked,
    });
    if (f.thumb.files[0]) video = (await api('PUT', `/api/videos/${id}/thumb`, f.thumb.files[0])).video;
    replaceVideo(video); render(); editDlg.close(); toast('저장했어요');
  } catch (ex) { $('#edit-error').textContent = ex.message; }
});
$('#edit-delete').addEventListener('click', async () => {
  const v = state.videos.find((x) => x.id === state.editId);
  if (!v || !confirm(`"${v.title}" 영상을 삭제할까요?\n영상 파일도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    await api('DELETE', `/api/videos/${v.id}`);
    state.videos = state.videos.filter((x) => x.id !== v.id);
    render(); editDlg.close(); toast('삭제했어요');
  } catch (ex) { $('#edit-error').textContent = ex.message; }
});

/* ---------- 설정 ---------- */
$('#btn-settings').addEventListener('click', async () => {
  try {
    const acc = await api('GET', '/api/account');
    for (const [form, id] of [['#viewer-form', acc.viewerId], ['#admin-form', acc.adminId]]) {
      const el = $(form); el.reset(); el.elements.id.value = id; $('.form-msg', el).textContent = '';
    }
    $('#settings').showModal();
  } catch (ex) { toast(ex.message); }
});
for (const [sel, role] of [['#viewer-form', 'viewer'], ['#admin-form', 'admin']]) {
  $(sel).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget, f = form.elements, msg = $('.form-msg', form);
    msg.className = 'form-msg';
    try {
      await api('PUT', '/api/account', { role, id: f.id.value.trim(), password: f.password.value, currentPassword: f.currentPassword.value });
      msg.textContent = role === 'viewer' ? '저장했어요. 이전 시청용 비밀번호로 로그인한 사람은 다시 로그인해야 합니다.' : '저장했어요.';
      f.password.value = ''; f.currentPassword.value = '';
    } catch (ex) { msg.className = 'form-msg bad'; msg.textContent = ex.message; }
  });
}

/* ---------- 시작 ---------- */
(async () => {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
    setTitle(me.title);
    if (me.role) await enter(me.role); else showLogin();
  } catch { showLogin(); }
})();
