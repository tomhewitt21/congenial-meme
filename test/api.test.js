import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let clock = new Date('2026-11-16T07:30:00Z'); // 07:30 in London
const sentPushes = [];
const push = {
  publicKey: 'test-key',
  async sendToUser(userId, payload) { sentPushes.push({ userId, payload }); return 1; },
};
const db = openDb(':memory:');
const app = createApp({
  db, push,
  config: { appName: 'Test Club', timeZone: 'Europe/London', wordsPerDay: 2, familyCode: 'RAINY-OTTER', publicDir: path.join(root, 'public'), now: () => clock },
});
let server; let base;

before(async () => {
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let admin; let mum;

test('join needs the right family code', async () => {
  const bad = await call('POST', '/api/join', { name: 'Tom', familyCode: 'nope' });
  assert.equal(bad.status, 403);
  const ok = await call('POST', '/api/join', { name: 'Tom', color: '#0F5C5A', familyCode: 'rainy otter' });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.me.isAdmin, true, 'first member is admin');
  admin = ok.data;
  const second = await call('POST', '/api/join', { name: 'Mum', color: '#7A4FB0', familyCode: 'RAINY-OTTER' });
  assert.equal(second.data.me.isAdmin, false);
  mum = second.data;
});

test('device is remembered and unknown tokens are rejected', async () => {
  assert.equal((await call('GET', '/api/me', null, admin.token)).data.name, 'Tom');
  assert.equal((await call('GET', '/api/me', null, 'garbage')).status, 401);
});

test('today has two seeded words, same for everyone', async () => {
  const a = await call('GET', '/api/today', null, admin.token);
  const b = await call('GET', '/api/today', null, mum.token);
  assert.equal(a.data.words.length, 2);
  assert.deepEqual(a.data.words.map((w) => w.word), b.data.words.map((w) => w.word));
  assert.equal(a.data.date, '2026-11-16');
});

test('comments, one-level replies, likes and reply notifications', async () => {
  const { data: t } = await call('GET', '/api/today', null, mum.token);
  const wid = t.words[0].id;
  let r = await call('POST', `/api/words/${wid}/comments`, { body: 'Lovely word' }, mum.token);
  const top = r.data.comments[0];
  r = await call('POST', `/api/words/${wid}/comments`, { body: 'Agreed', parentId: top.id }, admin.token);
  const reply = r.data.comments[0].replies[0];
  assert.equal(reply.body, 'Agreed');
  // Replying to a reply stays one level deep.
  r = await call('POST', `/api/words/${wid}/comments`, { body: 'Ha', parentId: reply.id }, mum.token);
  assert.equal(r.data.comments.length, 1);
  assert.equal(r.data.comments[0].replies.length, 2);
  assert.equal(r.data.commentCount, 3);
  assert.ok(sentPushes.some((p) => p.userId === mum.me.id && /Tom replied/.test(p.payload.title)));
  const like = await call('POST', `/api/comments/${top.id}/like`, null, admin.token);
  assert.equal(like.data.liked, true);
  // Mum can't delete Tom's comment; admin can delete anyone's.
  assert.equal((await call('DELETE', `/api/comments/${reply.id}`, null, mum.token)).status, 403);
  assert.equal((await call('DELETE', `/api/comments/${top.id}`, null, admin.token)).status, 200);
});

test('knew it / new to me are mutually exclusive', async () => {
  const { data: t } = await call('GET', '/api/today', null, mum.token);
  const wid = t.words[1].id;
  await call('POST', `/api/words/${wid}/reactions`, { kind: 'knew' }, mum.token);
  const r = await call('POST', `/api/words/${wid}/reactions`, { kind: 'new' }, mum.token);
  assert.deepEqual(r.data.myReactions, ['new']);
  assert.equal(r.data.reactions.knew, 0);
  assert.equal(r.data.reactions.new, 1);
});

test('future words are hidden from members', async () => {
  const { data } = await call('GET', '/api/admin/overview', null, admin.token);
  const future = data.upcoming.find((w) => w.date > data.today);
  assert.equal((await call('GET', `/api/words/${future.id}`, null, mum.token)).status, 404);
  assert.equal((await call('GET', '/api/admin/overview', null, mum.token)).status, 403);
});

test('rejoin code moves you to a new device', async () => {
  const r = await call('POST', '/api/rejoin', { code: mum.me.rejoinCode.toLowerCase() });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.id, mum.me.id);
  assert.notEqual(r.data.token, mum.token);
});

test('admin can add, remove and reorder words without gaps', async () => {
  const before = (await call('GET', '/api/admin/overview', null, admin.token)).data;
  const add = await call('POST', '/api/admin/words', { word: 'zzz-test', definition: 'A test word' }, admin.token);
  assert.equal(add.status, 200);
  let ov = (await call('GET', '/api/admin/overview', null, admin.token)).data;
  assert.equal(ov.upcoming.at(-1).word, 'zzz-test');
  assert.equal(ov.upcoming.length, before.upcoming.length + 1);
  // Remove tomorrow's first word: everything later shifts up one place.
  const tomorrow = ov.upcoming.find((w) => w.date > ov.today);
  const order = ov.upcoming.map((w) => w.word);
  await call('DELETE', `/api/admin/words/${tomorrow.id}`, null, admin.token);
  ov = (await call('GET', '/api/admin/overview', null, admin.token)).data;
  assert.deepEqual(ov.upcoming.map((w) => w.word), order.filter((w) => w !== tomorrow.word));
  const slots = ov.upcoming.map((w) => `${w.date}/${w.slot}`);
  assert.equal(new Set(slots).size, slots.length);
  // Swap two words.
  const [a, b] = ov.upcoming.filter((w) => w.date > ov.today);
  await call('POST', '/api/admin/move', { a: b.id, b: a.id }, admin.token);
  ov = (await call('GET', '/api/admin/overview', null, admin.token)).data;
  const after = ov.upcoming.filter((w) => w.date > ov.today);
  assert.equal(after[0].word, b.word);
  assert.equal(after[1].word, a.word);
});

test('daily push goes out once, at or after each person\'s time', async () => {
  db.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES ('https://push.example/1', ?, 'k', 'a')").run(mum.me.id);
  sentPushes.length = 0;
  clock = new Date('2026-11-16T07:59:00Z');
  assert.equal(await app.runDailyPush(), 0, 'not yet 08:00');
  clock = new Date('2026-11-16T08:01:00Z');
  assert.equal(await app.runDailyPush(), 1);
  assert.match(sentPushes[0].payload.title, /^Today's words: /);
  assert.equal(await app.runDailyPush(), 0, 'only once a day');
  clock = new Date('2026-11-17T08:00:00Z');
  assert.equal(await app.runDailyPush(), 1, 'again tomorrow');
});

test('streak counts consecutive days', async () => {
  clock = new Date('2026-11-18T09:00:00Z');
  await call('GET', '/api/today', null, admin.token);
  clock = new Date('2026-11-19T09:00:00Z');
  const r = await call('GET', '/api/today', null, admin.token);
  assert.equal(r.data.streak, 2);
});

test('static files are served and paths cannot escape public/', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<main id="app">/);
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
  const esc = await fetch(`${base}/..%2fpackage.json`);
  assert.notEqual(esc.status, 200);
});
