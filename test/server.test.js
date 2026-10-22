const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

let app;
let database;
let server;
let origin;
let temporaryData;

before(async () => {
  temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'commonroom-test-'));
  process.env.COMMONROOM_DATA_DIR = temporaryData;
  process.env.SESSION_SECRET = 'integration-test-secret';
  process.env.ADMIN_SETUP_KEY = 'integration-test-admin-key';
  ({ app, database } = require('../server'));
  server = await new Promise(resolve => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (database) database.close();
  if (temporaryData) fs.rmSync(temporaryData, { recursive: true, force: true });
});

async function send(route, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  let requestBody = body;
  if (cookie) headers.Cookie = cookie;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${route}`, { method, headers, body: requestBody });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('accounts, rooms, posts, media, replies, and admin controls use persistent server data', async () => {
  const emptyFeed = await send('/api/posts');
  assert.equal(emptyFeed.response.status, 200);
  assert.deepEqual(emptyFeed.payload.posts, []);

  const rooms = await send('/api/rooms');
  assert.ok(rooms.payload.rooms.every(room => room.postCount === 0));

  const anonymousPost = await send('/api/posts', {
    method: 'POST',
    body: new FormData()
  });
  assert.equal(anonymousPost.response.status, 401);

  const noKeyForReservedUsername = await send('/api/auth/signup', {
    method: 'POST',
    body: { username: 'admin', password: 'another-long-password' }
  });
  assert.equal(noKeyForReservedUsername.response.status, 403);
  const wrongSetupKey = await send('/api/auth/signup', {
    method: 'POST',
    body: { username: 'admin', password: 'another-long-password', adminSetupKey: 'wrong-key' }
  });
  assert.equal(wrongSetupKey.response.status, 403);

  const adminSignup = await send('/api/auth/signup', {
    method: 'POST',
    body: { username: 'admin', password: 'a-long-test-password', adminSetupKey: 'integration-test-admin-key' }
  });
  assert.equal(adminSignup.response.status, 201);
  assert.equal(adminSignup.payload.user.isAdmin, true);
  const adminCookie = adminSignup.cookie;

  const memberSignup = await send('/api/auth/signup', {
    method: 'POST',
    body: { username: 'morgan', password: 'another-long-password' }
  });
  assert.equal(memberSignup.payload.user.isAdmin, false);
  const memberCookie = memberSignup.cookie;

  const duplicateAdmin = await send('/api/auth/signup', {
    method: 'POST',
    body: { username: 'ADMIN', password: 'another-long-password', adminSetupKey: 'integration-test-admin-key' }
  });
  assert.equal(duplicateAdmin.response.status, 409);

  const badRoomForm = new FormData();
  badRoomForm.set('body', 'This should not land in a different room.');
  badRoomForm.set('room', 'not-a-room');
  const badRoom = await send('/api/posts', { method: 'POST', body: badRoomForm, cookie: memberCookie });
  assert.equal(badRoom.response.status, 400);

  const postForm = new FormData();
  postForm.set('body', 'A real post for the school room.');
  postForm.set('room', 'school');
  const createdPost = await send('/api/posts', { method: 'POST', body: postForm, cookie: memberCookie });
  assert.equal(createdPost.response.status, 201);
  assert.equal(createdPost.payload.post.room, 'school');

  const schoolFeed = await send('/api/posts?room=school');
  const gamingFeed = await send('/api/posts?room=gaming');
  assert.equal(schoolFeed.payload.posts.length, 1);
  assert.equal(schoolFeed.payload.posts[0].id, createdPost.payload.post.id);
  assert.deepEqual(gamingFeed.payload.posts, []);

  const photoForm = new FormData();
  photoForm.set('body', 'Shared a photo in gaming.');
  photoForm.set('room', 'gaming');
  photoForm.set('media', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'sample.png');
  const photoPost = await send('/api/posts', { method: 'POST', body: photoForm, cookie: memberCookie });
  assert.equal(photoPost.response.status, 201);
  assert.equal(photoPost.payload.post.mediaType, 'image/png');
  const uploadedPhoto = await fetch(`${origin}${photoPost.payload.post.mediaUrl}`);
  assert.equal(uploadedPhoto.status, 200);

  const profileForm = new FormData();
  profileForm.set('displayName', 'Morgan M.');
  profileForm.set('bio', 'Usually in the school room.');
  profileForm.set('avatar', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'avatar.png');
  const profile = await send('/api/profile', { method: 'POST', body: profileForm, cookie: memberCookie });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.payload.user.displayName, 'Morgan M.');
  assert.ok(profile.payload.user.avatarUrl.startsWith('/uploads/'));

  const memberLike = await send(`/api/posts/${createdPost.payload.post.id}/like`, { method: 'POST', cookie: memberCookie });
  assert.equal(memberLike.payload.liked, true);
  const reply = await send(`/api/posts/${createdPost.payload.post.id}/comments`, {
    method: 'POST', body: { body: 'I found that room too.' }, cookie: memberCookie
  });
  assert.equal(reply.response.status, 201);

  const otherSignup = await send('/api/auth/signup', {
    method: 'POST', body: { username: 'casey', password: 'yet-another-long-password' }
  });
  const forbiddenDelete = await send(`/api/posts/${createdPost.payload.post.id}`, { method: 'DELETE', cookie: otherSignup.cookie });
  assert.equal(forbiddenDelete.response.status, 403);

  const overview = await send('/api/admin/overview', { cookie: adminCookie });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.payload.totals.users, 3);
  assert.equal(overview.payload.totals.posts, 2);
  assert.equal(overview.payload.totals.replies, 1);

  const removed = await send(`/api/posts/${createdPost.payload.post.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(removed.response.status, 204);

  const suspension = await send(`/api/admin/users/${otherSignup.payload.user.id}/suspension`, {
    method: 'PATCH', body: { suspended: true }, cookie: adminCookie
  });
  assert.equal(suspension.response.status, 200);
  const suspendedLogin = await send('/api/auth/login', {
    method: 'POST', body: { username: 'casey', password: 'yet-another-long-password' }
  });
  assert.equal(suspendedLogin.response.status, 403);
});