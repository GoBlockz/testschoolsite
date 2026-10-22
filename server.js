const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = path.resolve(process.env.COMMONROOM_DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'commonroom_session';
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const ROOMS = [
  { id: 'gaming', label: 'Gaming', description: 'Games, co-op plans, and the stuff worth playing.' },
  { id: 'school', label: 'School', description: 'Class, campus life, and getting through the week.' },
  { id: 'creative', label: 'Making stuff', description: 'Art, projects, works in progress, and ideas.' },
  { id: 'music', label: 'Music & film', description: 'What you are listening to or watching lately.' },
  { id: 'life', label: 'Life lately', description: 'Small updates and the things on your mind.' },
  { id: 'random', label: 'Random', description: 'A little room for everything else.' }
];
const ROOM_IDS = new Set(ROOMS.map(room => room.id));
const FILE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
};
const blockedTerms = [
  /^nigg(?:er|a)s?$/,
  /^fagg?(?:ot)?s?$/,
  /^kikes?$/,
  /^chinks?$/,
  /^spics?$/,
  /^gooks?$/,
  /^wetbacks?$/,
  /^trann(?:y|ies)$/,
  /^retards?$/,
  /^ragheads?$/,
  /^towelheads?$/,
  /^pakis?$/
];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const database = new DatabaseSync(path.join(DATA_DIR, 'commonroom.sqlite'));
database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    is_suspended INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0, 1)),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_admin_account ON users(is_admin) WHERE is_admin = 1;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    media_path TEXT,
    media_type TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_room_created ON posts(room, created_at DESC);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS likes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
`);

const secretPath = path.join(DATA_DIR, 'session.secret');
const sessionSecret = process.env.SESSION_SECRET || (() => {
  if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(48), { mode: 0o600 });
  return fs.readFileSync(secretPath);
})();
const scrypt = promisify(crypto.scrypt);
const passwordCost = 64;
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_SETUP_KEY) {
  throw new Error('Set ADMIN_SETUP_KEY before starting the production server.');
}

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com']
    }
  }
}));
app.use(express.json({ limit: '32kb' }));

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    avatarUrl: user.avatar_path,
    isAdmin: Boolean(user.is_admin),
    isSuspended: Boolean(user.is_suspended),
    createdAt: user.created_at
  };
}

function signSession(sessionId) {
  return crypto.createHmac('sha256', sessionSecret).update(sessionId).digest('base64url');
}

function readSessionCookie(request) {
  const entry = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return null;
  const value = entry.slice(COOKIE_NAME.length + 1);
  const separator = value.lastIndexOf('.');
  if (separator < 1) return null;
  const sessionId = value.slice(0, separator);
  const receivedSignature = Buffer.from(value.slice(separator + 1));
  const expectedSignature = Buffer.from(signSession(sessionId));
  if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) return null;
  return sessionId;
}

function setSessionCookie(response, sessionId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.append('Set-Cookie', `${COOKIE_NAME}=${sessionId}.${signSession(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`);
}

function clearSessionCookie(response) {
  response.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

app.use((request, response, next) => {
  const sessionId = readSessionCookie(request);
  if (!sessionId) return next();
  const row = database.prepare(`
    SELECT sessions.id AS session_id, sessions.expires_at, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).get(sessionId);
  if (!row || row.expires_at < Date.now()) {
    if (row) database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    clearSessionCookie(response);
    return next();
  }
  request.sessionId = sessionId;
  request.user = row;
  next();
});

function requireAuth(request, response, next) {
  if (!request.user) return response.status(401).json({ error: 'Please log in to continue.' });
  if (request.user.is_suspended) return response.status(403).json({ error: 'This account is suspended.' });
  next();
}

function requireAdmin(request, response, next) {
  if (!request.user || !request.user.is_admin) return response.status(403).json({ error: 'Administrator access required.' });
  next();
}

function sameOrigin(request, response, next) {
  const origin = request.get('origin');
  if (!origin) return next();
  const expected = `${request.protocol}://${request.get('host')}`;
  if (origin !== expected) return response.status(403).json({ error: 'This request could not be verified.' });
  next();
}
app.use('/api', sameOrigin);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a little and try again.' }
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You are posting too quickly. Please wait a moment.' }
});

function createUploader(maxFileSize, imageOnly = false) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (request, file, callback) => callback(null, `${crypto.randomUUID()}${FILE_TYPES[file.mimetype] || '.bin'}`)
    }),
    limits: { fileSize: maxFileSize, files: 1 },
    fileFilter: (request, file, callback) => {
      const validType = FILE_TYPES[file.mimetype] && (!imageOnly || file.mimetype.startsWith('image/'));
      callback(validType ? null : new Error('Choose a supported photo or video file.'), Boolean(validType));
    }
  });
}
const postUpload = createUploader(12 * 1024 * 1024);
const avatarUpload = createUploader(5 * 1024 * 1024, true);

function normalizeToken(token) {
  return token.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/0/g, 'o').replace(/[^a-z0-9]/g, '');
}

function containsBlockedSlur(value) {
  return value.toLowerCase().split(/\s+/).map(normalizeToken).some(token => blockedTerms.some(pattern => pattern.test(token)));
}

function deleteUpload(mediaPath) {
  if (!mediaPath) return;
  const filename = path.basename(mediaPath);
  fs.rm(path.join(UPLOAD_DIR, filename), { force: true }, () => {});
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, passwordCost);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = (storedHash || '').split(':');
  if (!saltHex || !hashHex) {
    await scrypt(password, Buffer.alloc(16), passwordCost);
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function matchesSetupKey(receivedValue, expectedValue) {
  if (typeof receivedValue !== 'string' || typeof expectedValue !== 'string') return false;
  const received = Buffer.from(receivedValue);
  const expected = Buffer.from(expectedValue);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function beginSession(userId, response) {
  const id = crypto.randomBytes(32).toString('hex');
  database.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, Date.now() + SESSION_SECONDS * 1000);
  setSessionCookie(response, id);
}

function getPost(postId, viewerId) {
  const post = database.prepare(`
    SELECT posts.id, posts.room, posts.body, posts.media_path AS mediaUrl, posts.media_type AS mediaType,
      posts.created_at AS createdAt, users.id AS userId, users.username,
      users.display_name AS displayName, users.avatar_path AS avatarUrl, users.is_admin AS isAdmin,
      (SELECT count(*) FROM likes WHERE likes.post_id = posts.id) AS likes,
      (SELECT count(*) FROM comments WHERE comments.post_id = posts.id) AS replyCount,
      EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) AS likedByMe
    FROM posts JOIN users ON users.id = posts.user_id WHERE posts.id = ?
  `).get(viewerId || '', postId);
  if (!post) return null;
  post.isAdmin = Boolean(post.isAdmin);
  post.likedByMe = Boolean(post.likedByMe);
  post.replies = database.prepare(`
    SELECT comments.id, comments.body, comments.created_at AS createdAt,
      users.username, users.display_name AS displayName, users.avatar_path AS avatarUrl
    FROM comments JOIN users ON users.id = comments.user_id
    WHERE comments.post_id = ? ORDER BY comments.created_at ASC
  `).all(postId);
  return post;
}

function listPosts({ room = 'all', search = '', sort = 'recent', limit = 50 }, viewerId = '') {
  const conditions = [];
  const parameters = [viewerId];
  if (room !== 'all') {
    conditions.push('posts.room = ?');
    parameters.push(room);
  }
  if (search) {
    conditions.push('(posts.body LIKE ? OR users.username LIKE ? OR users.display_name LIKE ?)');
    const searchValue = `%${search}%`;
    parameters.push(searchValue, searchValue, searchValue);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const ordering = sort === 'popular' ? 'likes DESC, posts.created_at DESC' : 'posts.created_at DESC';
  parameters.push(limit);
  const rows = database.prepare(`
    SELECT posts.id, posts.room, posts.body, posts.media_path AS mediaUrl, posts.media_type AS mediaType,
      posts.created_at AS createdAt, users.id AS userId, users.username,
      users.display_name AS displayName, users.avatar_path AS avatarUrl, users.is_admin AS isAdmin,
      (SELECT count(*) FROM likes WHERE likes.post_id = posts.id) AS likes,
      (SELECT count(*) FROM comments WHERE comments.post_id = posts.id) AS replyCount,
      EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) AS likedByMe
    FROM posts JOIN users ON users.id = posts.user_id ${where}
    ORDER BY ${ordering} LIMIT ?
  `).all(...parameters);
  return rows.map(post => {
    post.isAdmin = Boolean(post.isAdmin);
    post.likedByMe = Boolean(post.likedByMe);
    post.replies = database.prepare(`
      SELECT comments.id, comments.body, comments.created_at AS createdAt,
        users.username, users.display_name AS displayName, users.avatar_path AS avatarUrl
      FROM comments JOIN users ON users.id = comments.user_id
      WHERE comments.post_id = ? ORDER BY comments.created_at ASC
    `).all(post.id);
    return post;
  });
}

app.get('/api/health', (request, response) => response.json({ status: 'ok' }));

app.post('/api/auth/signup', authLimiter, async (request, response, next) => {
  try {
    const username = typeof request.body.username === 'string' ? request.body.username.trim().toLowerCase() : '';
    const password = typeof request.body.password === 'string' ? request.body.password : '';
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return response.status(400).json({ error: 'Choose a username with 3–20 letters, numbers, or underscores.' });
    if (password.length < 10 || password.length > 128) return response.status(400).json({ error: 'Use a password between 10 and 128 characters.' });
    if (username === 'admin' && process.env.ADMIN_SETUP_KEY && !matchesSetupKey(request.body.adminSetupKey, process.env.ADMIN_SETUP_KEY)) {
      return response.status(403).json({ error: 'An administrator setup key is required for this username.' });
    }
    if (database.prepare('SELECT id FROM users WHERE username = ?').get(username)) return response.status(409).json({ error: 'That username is already taken.' });
    const userId = crypto.randomUUID();
    const now = Date.now();
    const passwordHash = await hashPassword(password);
    const admin = username === 'admin' ? 1 : 0;
    database.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, username, passwordHash, username, admin, now);
    beginSession(userId, response);
    response.status(201).json({ user: publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE constraint failed')) {
      return response.status(409).json({ error: 'That account is already registered.' });
    }
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (request, response, next) => {
  try {
    const username = typeof request.body.username === 'string' ? request.body.username.trim().toLowerCase() : '';
    const password = typeof request.body.password === 'string' ? request.body.password : '';
    if (!username || !password) return response.status(400).json({ error: 'Enter your username and password.' });
    const user = database.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const valid = await verifyPassword(password, user?.password_hash);
    if (!user || !valid) return response.status(401).json({ error: 'That username and password do not match.' });
    if (user.is_suspended) return response.status(403).json({ error: 'This account is suspended.' });
    beginSession(user.id, response);
    response.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (request, response) => {
  if (request.sessionId) database.prepare('DELETE FROM sessions WHERE id = ?').run(request.sessionId);
  clearSessionCookie(response);
  response.status(204).end();
});

app.get('/api/auth/me', (request, response) => response.json({ user: publicUser(request.user) }));

app.get('/api/rooms', (request, response) => {
  const counts = database.prepare('SELECT room, count(*) AS postCount FROM posts GROUP BY room').all();
  const countByRoom = new Map(counts.map(row => [row.room, row.postCount]));
  response.json({ rooms: ROOMS.map(room => ({ ...room, postCount: countByRoom.get(room.id) || 0 })) });
});

app.get('/api/posts', (request, response) => {
  const room = typeof request.query.room === 'string' ? request.query.room : 'all';
  const search = typeof request.query.search === 'string' ? request.query.search.trim().slice(0, 100) : '';
  const sort = request.query.sort === 'popular' ? 'popular' : 'recent';
  if (room !== 'all' && !ROOM_IDS.has(room)) return response.status(400).json({ error: 'Choose a valid room.' });
  const posts = listPosts({ room, search, sort }, request.user?.id);
  response.json({ posts });
});

app.post('/api/posts', writeLimiter, requireAuth, postUpload.single('media'), (request, response, next) => {
  try {
    const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
    const room = typeof request.body.room === 'string' ? request.body.room : '';
    if (!ROOM_IDS.has(room)) {
      if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
      return response.status(400).json({ error: 'Choose a valid room before posting.' });
    }
    if (body.length > 1200) {
      if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
      return response.status(400).json({ error: 'Posts can be up to 1,200 characters.' });
    }
    if (!body && !request.file) return response.status(400).json({ error: 'Write something or add a photo/video first.' });
    if (containsBlockedSlur(body)) {
      if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
      return response.status(400).json({ error: 'Strong language is okay; slurs are not welcome here.' });
    }
    const postId = crypto.randomUUID();
    const mediaPath = request.file ? `/uploads/${request.file.filename}` : null;
    database.prepare(`
      INSERT INTO posts (id, user_id, room, body, media_path, media_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(postId, request.user.id, room, body, mediaPath, request.file?.mimetype || null, Date.now());
    response.status(201).json({ post: getPost(postId, request.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/posts/:postId/comments', writeLimiter, requireAuth, (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
  if (!body || body.length > 500) return response.status(400).json({ error: 'Replies need 1–500 characters.' });
  if (containsBlockedSlur(body)) return response.status(400).json({ error: 'Strong language is okay; slurs are not welcome here.' });
  if (!database.prepare('SELECT id FROM posts WHERE id = ?').get(request.params.postId)) return response.status(404).json({ error: 'Post not found.' });
  const commentId = crypto.randomUUID();
  database.prepare('INSERT INTO comments (id, post_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(commentId, request.params.postId, request.user.id, body, Date.now());
  const comment = database.prepare(`
    SELECT comments.id, comments.body, comments.created_at AS createdAt,
      users.username, users.display_name AS displayName, users.avatar_path AS avatarUrl
    FROM comments JOIN users ON users.id = comments.user_id WHERE comments.id = ?
  `).get(commentId);
  response.status(201).json({ comment });
});

app.post('/api/posts/:postId/like', requireAuth, (request, response) => {
  if (!database.prepare('SELECT id FROM posts WHERE id = ?').get(request.params.postId)) return response.status(404).json({ error: 'Post not found.' });
  const exists = database.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(request.user.id, request.params.postId);
  if (exists) database.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(request.user.id, request.params.postId);
  else database.prepare('INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(request.user.id, request.params.postId, Date.now());
  const likes = database.prepare('SELECT count(*) AS count FROM likes WHERE post_id = ?').get(request.params.postId).count;
  response.json({ liked: !exists, likes });
});

app.delete('/api/posts/:postId', requireAuth, (request, response) => {
  const post = database.prepare('SELECT id, user_id, media_path FROM posts WHERE id = ?').get(request.params.postId);
  if (!post) return response.status(404).json({ error: 'Post not found.' });
  if (post.user_id !== request.user.id && !request.user.is_admin) return response.status(403).json({ error: 'You can only remove your own posts.' });
  database.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  deleteUpload(post.media_path);
  response.status(204).end();
});

app.post('/api/profile', requireAuth, avatarUpload.single('avatar'), (request, response) => {
  const displayName = typeof request.body.displayName === 'string' ? request.body.displayName.trim() : request.user.display_name;
  const bio = typeof request.body.bio === 'string' ? request.body.bio.trim() : request.user.bio;
  if (!displayName || displayName.length > 40) {
    if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
    return response.status(400).json({ error: 'Display names need 1–40 characters.' });
  }
  if (bio.length > 160) {
    if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
    return response.status(400).json({ error: 'Bios can be up to 160 characters.' });
  }
  const avatarPath = request.file ? `/uploads/${request.file.filename}` : request.user.avatar_path;
  database.prepare('UPDATE users SET display_name = ?, bio = ?, avatar_path = ? WHERE id = ?').run(displayName, bio, avatarPath, request.user.id);
  if (request.file && request.user.avatar_path) deleteUpload(request.user.avatar_path);
  response.json({ user: publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id)) });
});

app.get('/api/admin/overview', requireAuth, requireAdmin, (request, response) => {
  const users = database.prepare(`
    SELECT id, username, display_name AS displayName, avatar_path AS avatarUrl,
      is_admin AS isAdmin, is_suspended AS isSuspended, created_at AS createdAt
    FROM users ORDER BY created_at DESC LIMIT 100
  `).all().map(user => ({ ...user, isAdmin: Boolean(user.isAdmin), isSuspended: Boolean(user.isSuspended) }));
  const totals = database.prepare(`
    SELECT (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM posts) AS posts,
      (SELECT count(*) FROM comments) AS replies
  `).get();
  response.json({ totals, users, posts: listPosts({ limit: 50 }, request.user.id) });
});

app.patch('/api/admin/users/:userId/suspension', requireAuth, requireAdmin, (request, response) => {
  const target = database.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(request.params.userId);
  if (!target) return response.status(404).json({ error: 'Account not found.' });
  if (target.is_admin || target.id === request.user.id) return response.status(400).json({ error: 'The administrator account cannot be suspended.' });
  const suspended = Boolean(request.body.suspended);
  database.prepare('UPDATE users SET is_suspended = ? WHERE id = ?').run(suspended ? 1 : 0, target.id);
  if (suspended) database.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  response.json({ id: target.id, suspended });
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  fallthrough: false,
  maxAge: '1h',
  setHeaders(response) { response.setHeader('X-Content-Type-Options', 'nosniff'); }
}));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use('/api', (request, response) => response.status(404).json({ error: 'That API route does not exist.' }));

app.use((error, request, response, next) => {
  if (request.file) deleteUpload(`/uploads/${request.file.filename}`);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'That upload could not be accepted.';
    return response.status(400).json({ error: message });
  }
  if (error.message === 'Choose a supported photo or video file.') return response.status(400).json({ error: error.message });
  console.error(error);
  response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Commonroom is listening on http://localhost:${PORT}`));
}

module.exports = { app, database, containsBlockedSlur };