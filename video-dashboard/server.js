'use strict';
// 여행 영상 대시보드 서버 — 외부 패키지 없이 Node.js(18+)만으로 동작합니다.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SITE_TITLE = (process.env.SITE_TITLE || '여행 필름').slice(0, 40);
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 2048) * 1024 * 1024;
const MAX_THUMB_BYTES = 3 * 1024 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_DAYS = { admin: 7, viewer: 30 };
const COOKIE = 'tv_session';

const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let config; // { secret, users: { admin: {id, salt, hash, ver}, viewer: {...} } }
let db;     // { videos: [...] }

/* ---------- 저장소 ---------- */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const saveDb = () => writeJsonAtomic(DB_FILE, db);
const saveConfig = () => writeJsonAtomic(CONFIG_FILE, config);

async function hashPassword(password, salt) {
  return (await scrypt(password.normalize('NFKC'), salt, 32)).toString('base64url');
}
async function makeUser(id, password, ver = 1) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { id, salt, hash: await hashPassword(password, salt), ver };
}

async function init() {
  for (const dir of [DATA_DIR, VIDEO_DIR, THUMB_DIR]) fs.mkdirSync(dir, { recursive: true });
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = { videos: [] }; }
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { config = {}; }
  if (!config.secret) config.secret = crypto.randomBytes(32).toString('base64url');

  if (process.argv[2] === 'reset') delete config.users;
  if (!config.users) {
    const randomPw = () => crypto.randomBytes(9).toString('base64url');
    const admin = { id: process.env.ADMIN_ID || 'admin', pw: process.env.ADMIN_PASSWORD || randomPw() };
    const viewer = { id: process.env.VIEWER_ID || 'guest', pw: process.env.VIEWER_PASSWORD || randomPw() };
    if (admin.id === viewer.id) throw new Error('ADMIN_ID와 VIEWER_ID는 서로 달라야 합니다.');
    config.users = {
      admin: await makeUser(admin.id, admin.pw, Date.now()),
      viewer: await makeUser(viewer.id, viewer.pw, Date.now()),
    };
    console.log('\n================ 계정이 만들어졌습니다 ================');
    console.log(` 관리자(업로드·수정)  ID: ${admin.id}   비밀번호: ${process.env.ADMIN_PASSWORD ? '(환경변수 값)' : admin.pw}`);
    console.log(` 시청용(공유)        ID: ${viewer.id}   비밀번호: ${process.env.VIEWER_PASSWORD ? '(환경변수 값)' : viewer.pw}`);
    console.log(' 이 안내는 다시 표시되지 않습니다. 로그인 후 설정에서 바꿀 수 있습니다.');
    console.log('======================================================\n');
  }
  saveConfig();
  if (process.argv[2] === 'reset') { console.log('계정을 초기화했습니다.'); process.exit(0); }
}

/* ---------- 세션 ---------- */
const sign = (payload) => crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function makeToken(role) {
  const exp = Date.now() + SESSION_DAYS[role] * 86400e3;
  const payload = `${role}.${config.users[role].ver}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function roleFromRequest(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 4) return null;
  const [role, ver, exp, sig] = parts;
  if (!safeEqual(sig, sign(`${role}.${ver}.${exp}`))) return null;
  const user = config.users[role];
  if (!user || String(user.ver) !== ver || Number(exp) < Date.now()) return null;
  return role;
}
function isHttps(req) {
  return Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}
function sessionCookie(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

/* ---------- 로그인 시도 제한 ---------- */
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10, ATTEMPT_WINDOW = 15 * 60e3;
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function isLocked(ip) {
  const a = attempts.get(ip);
  if (a && a.resetAt < Date.now()) { attempts.delete(ip); return false; }
  return Boolean(a && a.count >= MAX_ATTEMPTS);
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, resetAt: Date.now() + ATTEMPT_WINDOW };
  a.count++; attempts.set(ip, a);
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of attempts) if (a.resetAt < now) attempts.delete(ip); }, 60e3).unref();

/* ---------- HTTP 도우미 ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (v && typeof v === 'object') return v; } catch {}
  throw new HttpError(400, '잘못된 요청입니다.');
}
async function receiveFile(req, dest, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, '파일이 너무 큽니다.');
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > maxBytes ? new HttpError(413, '파일이 너무 큽니다.') : null, chunk);
    },
  });
  try { await pipeline(req, limiter, fs.createWriteStream(dest, { mode: 0o600 })); }
  catch (e) { await fsp.rm(dest, { force: true }); throw e instanceof HttpError ? e : new HttpError(400, '업로드가 중단되었습니다.'); }
  if (!size) { await fsp.rm(dest, { force: true }); throw new HttpError(400, '빈 파일입니다.'); }
  return size;
}
async function readHead(file, n = 16) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(n); await fh.read(buf, 0, n, 0); return buf; } finally { await fh.close(); }
}
function sniffVideo(head) {
  if (head.toString('latin1', 4, 8) === 'ftyp') {
    return head.toString('latin1', 8, 12) === 'qt  ' ? { ext: 'mov', mime: 'video/quicktime' } : { ext: 'mp4', mime: 'video/mp4' };
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) return { ext: 'webm', mime: 'video/webm' };
  return null;
}
function sniffImage(head) {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (head.readUInt32BE(0) === 0x89504e47) return { ext: 'png', mime: 'image/png' };
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
const MIME_BY_EXT = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

async function sendFile(req, res, file, mime, cacheControl) {
  let st;
  try { st = await fsp.stat(file); } catch { throw new HttpError(404, '파일을 찾을 수 없습니다.'); }
  const headers = { 'Content-Type': mime, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' };
  let start = 0, end = st.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else { start = Math.max(0, st.size - Number(range[2])); }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
    }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

/* ---------- 영상 메타데이터 ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
function cleanMeta(input) {
  const out = {};
  const title = str(input.title, 120); if (title !== undefined) out.title = title;
  const description = str(input.description, 2000); if (description !== undefined) out.description = description;
  const location = str(input.location, 60); if (location !== undefined) out.location = location;
  if (typeof input.date === 'string' && (input.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(input.date))) out.date = input.date;
  if (Array.isArray(input.tags)) {
    out.tags = [...new Set(input.tags.map((t) => str(t, 30)).filter(Boolean))].slice(0, 20);
  }
  if (typeof input.featured === 'boolean') out.featured = input.featured;
  for (const key of ['duration', 'width', 'height']) {
    const n = Number(input[key]);
    if (input[key] !== undefined && Number.isFinite(n) && n >= 0 && n < 1e6) out[key] = Math.round(n * 10) / 10;
  }
  return out;
}
const findVideo = (id) => {
  const v = db.videos.find((x) => x.id === id);
  if (!v) throw new HttpError(404, '영상을 찾을 수 없습니다.');
  return v;
};
const removeIfExists = (dir, name) => (name ? fsp.rm(path.join(dir, name), { force: true }) : Promise.resolve());

/* ---------- 라우터 ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  if ((method === 'GET' || method === 'HEAD') && STATIC[p]) {
    const [file, mime] = STATIC[p];
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; " +
      "img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return sendFile(req, res, path.join(PUBLIC_DIR, file), mime, 'no-cache');
  }

  // 상태를 바꾸는 요청은 같은 출처 + 전용 헤더가 있어야 합니다 (CSRF 방지).
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (req.headers['x-requested-with'] !== 'tv' || (origin && new URL(origin).host !== req.headers.host)) {
      throw new HttpError(403, '허용되지 않은 요청입니다.');
    }
  }

  const role = roleFromRequest(req);

  if (p === '/api/me' && method === 'GET') return sendJson(res, 200, { role, title: SITE_TITLE });

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (isLocked(ip)) throw new HttpError(429, '로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도하세요.');
    const body = await readJson(req);
    const id = str(body.id, 100) || '', password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    let matched = null;
    for (const r of ['admin', 'viewer']) {
      const u = config.users[r];
      const ok = safeEqual(await hashPassword(password, u.salt), u.hash) && safeEqual(id, u.id);
      if (ok) matched = r;
    }
    if (!matched) { recordFailure(ip); throw new HttpError(401, '아이디 또는 비밀번호가 맞지 않습니다.'); }
    attempts.delete(ip);
    return sendJson(res, 200, { role: matched, title: SITE_TITLE },
      { 'Set-Cookie': sessionCookie(req, makeToken(matched), SESSION_DAYS[matched] * 86400) });
  }

  if (p === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (!role) throw new HttpError(401, '로그인이 필요합니다.');
  const admin = role === 'admin';
  const requireAdmin = () => { if (!admin) throw new HttpError(403, '관리자만 할 수 있습니다.'); };

  let m;
  if (p === '/api/videos' && method === 'GET') {
    return sendJson(res, 200, { videos: admin ? db.videos : db.videos.filter((v) => v.file) });
  }

  if (p === '/api/videos' && method === 'POST') {
    requireAdmin();
    const meta = cleanMeta(await readJson(req));
    const now = new Date().toISOString();
    const video = {
      id: crypto.randomBytes(8).toString('hex'),
      title: meta.title || '제목 없음', description: meta.description || '', location: meta.location || '',
      date: meta.date || '', tags: meta.tags || [], featured: Boolean(meta.featured),
      duration: meta.duration || 0, width: meta.width || 0, height: meta.height || 0,
      file: null, mime: null, size: 0, thumb: null, thumbVer: 0, views: 0, createdAt: now, updatedAt: now,
    };
    db.videos.push(video); saveDb();
    return sendJson(res, 201, { video });
  }

  if ((m = /^\/api\/videos\/([0-9a-f]{16})$/.exec(p))) {
    const video = findVideo(m[1]);
    if (method === 'PATCH') {
      requireAdmin();
      Object.assign(video, cleanMeta(await readJson(req)), { updatedAt: new Date().toISOString() });
      if (!video.title) video.title = '제목 없음';
      saveDb();
      return sendJson(res, 200, { video });
    }
    if (method === 'DELETE') {
      requireAdmin();
      db.videos = db.videos.filter((v) => v !== video); saveDb();
      await Promise.all([removeIfExists(VIDEO_DIR, video.file), removeIfExists(THUMB_DIR, video.thumb)]);
      return sendJson(res, 200, { ok: true });
    }
  }

  if ((m = /^\/api\/videos\/([0-9a-f]{16})\/file$/.exec(p)) && method === 'PUT') {
    requireAdmin();
    const video = findVideo(m[1]);
    const tmp = path.join(VIDEO_DIR, `${video.id}.${crypto.randomBytes(4).toString('hex')}.part`);
    const size = await receiveFile(req, tmp, MAX_UPLOAD_BYTES);
    const kind = sniffVideo(await readHead(tmp));
    if (!kind) { await fsp.rm(tmp, { force: true }); throw new HttpError(415, 'MP4, MOV, WebM 영상만 올릴 수 있습니다.'); }
    const name = `${video.id}.${kind.ext}`;
    if (video.file && video.file !== name) await removeIfExists(VIDEO_DIR, video.file);
    await fsp.rename(tmp, path.join(VIDEO_DIR, name));
    Object.assign(video, { file: name, mime: kind.mime, size, updatedAt: new Date().toISOString() });
    saveDb();
    return sendJson(res, 200, { video });
  }

  if ((m = /^\/api\/videos\/([0-9a-f]{16})\/thumb$/.exec(p)) && method === 'PUT') {
    requireAdmin();
    const video = findVideo(m[1]);
    const tmp = path.join(THUMB_DIR, `${video.id}.${crypto.randomBytes(4).toString('hex')}.part`);
    await receiveFile(req, tmp, MAX_THUMB_BYTES);
    const kind = sniffImage(await readHead(tmp));
    if (!kind) { await fsp.rm(tmp, { force: true }); throw new HttpError(415, 'JPG, PNG, WebP 이미지만 쓸 수 있습니다.'); }
    const name = `${video.id}.${kind.ext}`;
    if (video.thumb && video.thumb !== name) await removeIfExists(THUMB_DIR, video.thumb);
    await fsp.rename(tmp, path.join(THUMB_DIR, name));
    Object.assign(video, { thumb: name, thumbVer: Date.now(), updatedAt: new Date().toISOString() });
    saveDb();
    return sendJson(res, 200, { video });
  }

  if ((m = /^\/api\/videos\/([0-9a-f]{16})\/view$/.exec(p)) && method === 'POST') {
    const video = findVideo(m[1]);
    video.views = (video.views || 0) + 1; saveDb();
    return sendJson(res, 200, { views: video.views });
  }

  if ((m = /^\/media\/([0-9a-f]{16})$/.exec(p)) && (method === 'GET' || method === 'HEAD')) {
    const video = findVideo(m[1]);
    if (!video.file) throw new HttpError(404, '파일을 찾을 수 없습니다.');
    return sendFile(req, res, path.join(VIDEO_DIR, video.file), video.mime || MIME_BY_EXT[video.file.split('.').pop()], 'private, max-age=3600');
  }

  if ((m = /^\/thumb\/([0-9a-f]{16})$/.exec(p)) && (method === 'GET' || method === 'HEAD')) {
    const video = findVideo(m[1]);
    if (!video.thumb) throw new HttpError(404, '파일을 찾을 수 없습니다.');
    return sendFile(req, res, path.join(THUMB_DIR, video.thumb), MIME_BY_EXT[video.thumb.split('.').pop()], 'private, max-age=31536000, immutable');
  }

  if (p === '/api/account' && method === 'PUT') {
    requireAdmin();
    const body = await readJson(req);
    const target = body.role === 'admin' ? 'admin' : body.role === 'viewer' ? 'viewer' : null;
    if (!target) throw new HttpError(400, '잘못된 요청입니다.');
    const me = config.users.admin;
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!safeEqual(await hashPassword(current, me.salt), me.hash)) throw new HttpError(403, '현재 관리자 비밀번호가 맞지 않습니다.');
    const id = str(body.id, 40) || config.users[target].id;
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^\S{3,40}$/.test(id)) throw new HttpError(400, '아이디는 공백 없이 3~40자로 입력하세요.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, '비밀번호는 8자 이상으로 입력하세요.');
    const other = target === 'admin' ? 'viewer' : 'admin';
    if (id === config.users[other].id) throw new HttpError(400, '관리자와 시청용 아이디는 서로 달라야 합니다.');
    config.users[target] = await makeUser(id, password, Date.now());
    saveConfig();
    // 관리자 계정을 바꾸면 기존 세션이 무효가 되므로 새 쿠키를 내려줍니다.
    const headers = target === 'admin' ? { 'Set-Cookie': sessionCookie(req, makeToken('admin'), SESSION_DAYS.admin * 86400) } : {};
    return sendJson(res, 200, { ok: true, id }, headers);
  }

  if (p === '/api/account' && method === 'GET') {
    requireAdmin();
    return sendJson(res, 200, { adminId: config.users.admin.id, viewerId: config.users.viewer.id });
  }

  throw new HttpError(404, '찾을 수 없습니다.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    // 본문을 다 읽지 않고 응답하는 경우(업로드 거부 등) 연결을 닫습니다.
    const headers = req.complete ? {} : { Connection: 'close' };
    sendJson(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : err.message }, headers);
  });
});
server.requestTimeout = 0; // 큰 파일 업로드가 중간에 끊기지 않도록

init().then(() => {
  server.listen(PORT, HOST, () => console.log(`${SITE_TITLE} — http://localhost:${PORT} (데이터: ${DATA_DIR})`));
}).catch((err) => { console.error(err.message); process.exit(1); });
