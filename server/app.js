import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getSetting, setSetting, tx } from './db.js';
import { localDate, localTime, addDays, isClock } from './time.js';
import { SEED_WORDS } from './seed-words.js';

export const REACTIONS = ['knew', 'new', 'love', 'use'];
export const COLORS = ['#0F5C5A', '#7A4FB0', '#2F6DB5', '#B5452F', '#C2571A', '#3E7B3A', '#8A6D1F', '#B03A6E'];

const MAX_BODY = 32 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

function makeRejoinCode() {
  // No 0/O/1/I/L so it's easy to read out over the phone.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 3 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

function makeFamilyCode() {
  const a = ['RAINY', 'SUNNY', 'WINDY', 'MISTY', 'FROSTY', 'BREEZY', 'CLOUDY', 'STORMY'];
  const b = ['OTTER', 'BADGER', 'HERON', 'ROBIN', 'HARE', 'WREN', 'FOX', 'OWL'];
  return `${a[randomInt(a.length)]}-${b[randomInt(b.length)]}`;
}

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function cleanText(v, max, field, { required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

export function createApp({ db, config, push }) {
  const now = config.now || (() => new Date());
  const today = () => localDate(config.timeZone, now());
  const wordsPerDay = () => Number(getSetting(db, 'words_per_day') || config.wordsPerDay || 2);

  // ---------- first-run setup ----------
  // FAMILY_CODE only sets the starting code. After that the admin changes it in the app,
  // and a restart must not undo that.
  if (!getSetting(db, 'family_code')) {
    setSetting(db, 'family_code', config.familyCode || makeFamilyCode());
  }
  if (!getSetting(db, 'words_per_day')) setSetting(db, 'words_per_day', config.wordsPerDay || 2);
  const wordCount = db.prepare('SELECT COUNT(*) AS n FROM words').get().n;
  if (wordCount === 0 && config.seed !== false) {
    tx(db, () => { for (const w of SEED_WORDS) insertWord(w); });
  }

  // ---------- simple brute-force protection for codes ----------
  const attempts = new Map(); // ip -> { n, until }
  function checkAttempts(ip) {
    const a = attempts.get(ip);
    if (a && a.n >= 10 && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }
  function failAttempt(ip) {
    const a = attempts.get(ip);
    if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60 * 1000 });
    else a.n++;
  }

  // ---------- word scheduling ----------
  function nextFreeSlot() {
    const perDay = wordsPerDay();
    const t = today();
    const last = db.prepare('SELECT publish_date AS d, COUNT(*) AS n FROM words WHERE publish_date >= ? GROUP BY publish_date ORDER BY publish_date DESC LIMIT 1').get(t);
    if (!last) {
      const nToday = db.prepare('SELECT COUNT(*) AS n FROM words WHERE publish_date = ?').get(t).n;
      return nToday < perDay ? { day: t, slot: nToday } : { day: addDays(t, 1), slot: 0 };
    }
    if (last.n < perDay) {
      const maxSlot = db.prepare('SELECT MAX(slot) AS s FROM words WHERE publish_date = ?').get(last.d).s;
      return { day: last.d, slot: maxSlot + 1 };
    }
    return { day: addDays(last.d, 1), slot: 0 };
  }

  function insertWord(w, at) {
    const { day, slot } = at || nextFreeSlot();
    const info = db.prepare(`INSERT INTO words (publish_date, slot, word, part_of_speech, pronunciation, definition, example, origin, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      day, slot, w.word, w.part_of_speech || '', w.pronunciation || '', w.definition,
      w.example || '', w.origin || '', w.prompt || '',
    );
    return Number(info.lastInsertRowid);
  }

  function validWordInput(b) {
    return {
      word: cleanText(b.word, 60, 'Word', { required: true }),
      part_of_speech: cleanText(b.part_of_speech, 30, 'Part of speech'),
      pronunciation: cleanText(b.pronunciation, 60, 'Pronunciation'),
      definition: cleanText(b.definition, 400, 'Definition', { required: true }),
      example: cleanText(b.example, 400, 'Example'),
      origin: cleanText(b.origin, 400, 'Origin'),
      prompt: cleanText(b.prompt, 200, 'Prompt'),
    };
  }

  // ---------- users ----------
  function publicUser(u) {
    return { id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin };
  }

  function issueDevice(userId, req) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO devices (token_hash, user_id, user_agent) VALUES (?, ?, ?)')
      .run(hash(token), userId, String(req.headers['user-agent'] || '').slice(0, 200));
    return token;
  }

  function authUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = hash(m[1]);
    const u = db.prepare('SELECT u.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?').get(h);
    if (u) db.prepare("UPDATE devices SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(h);
    return u || null;
  }

  function streak(userId) {
    const days = new Set(db.prepare('SELECT day FROM visits WHERE user_id = ?').all(userId).map((r) => r.day));
    let d = today();
    if (!days.has(d)) d = addDays(d, -1);
    let n = 0;
    while (days.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  function meFull(u) {
    const t = today();
    return {
      ...publicUser(u),
      rejoinCode: u.rejoin_code,
      notifyTime: u.notify_time,
      notifyReplies: !!u.notify_replies,
      joinedAt: u.created_at,
      streak: streak(u.id),
      stats: {
        wordsSeen: db.prepare('SELECT COUNT(*) AS n FROM words WHERE publish_date <= ? AND publish_date >= ?').get(t, u.created_at.slice(0, 10)).n,
        comments: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ?').get(u.id).n,
        newToMe: db.prepare("SELECT COUNT(*) AS n FROM reactions WHERE user_id = ? AND kind = 'new'").get(u.id).n,
      },
      pushDevices: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(u.id).n,
      // Members can invite others, so they get the family code for the invite link.
      familyCode: getSetting(db, 'family_code'),
    };
  }

  // ---------- words with their community data ----------
  function wordFull(w, me) {
    const counts = Object.fromEntries(REACTIONS.map((k) => [k, 0]));
    for (const r of db.prepare('SELECT kind, COUNT(*) AS n FROM reactions WHERE word_id = ? GROUP BY kind').all(w.id)) counts[r.kind] = r.n;
    const mine = db.prepare('SELECT kind FROM reactions WHERE word_id = ? AND user_id = ?').all(w.id, me.id).map((r) => r.kind);
    const saved = !!db.prepare('SELECT 1 FROM saved WHERE word_id = ? AND user_id = ?').get(w.id, me.id);

    const rows = db.prepare(`
      SELECT c.id, c.parent_id, c.body, c.created_at, c.user_id, u.name, u.color,
        (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes,
        EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ?) AS liked
      FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.word_id = ? ORDER BY c.created_at ASC, c.id ASC`).all(me.id, w.id);
    const byId = new Map();
    const top = [];
    for (const r of rows) {
      const c = {
        id: r.id, body: r.body, createdAt: r.created_at, likes: r.likes, liked: !!r.liked,
        author: { id: r.user_id, name: r.name, color: r.color },
        canDelete: r.user_id === me.id || !!me.is_admin,
        replies: [],
      };
      byId.set(r.id, c);
      if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).replies.push(c);
      else top.push(c);
    }
    return {
      id: w.id, date: w.publish_date, slot: w.slot, word: w.word, partOfSpeech: w.part_of_speech,
      pronunciation: w.pronunciation, definition: w.definition, example: w.example,
      origin: w.origin, prompt: w.prompt,
      reactions: counts, myReactions: mine, saved,
      commentCount: rows.length,
      comments: top,
    };
  }

  function getVisibleWord(id, me) {
    const w = db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!w || (w.publish_date > today() && !me.is_admin)) throw new HttpError(404, 'Word not found');
    return w;
  }

  // ---------- notifications ----------
  async function runDailyPush() {
    const t = today();
    const clock = localTime(config.timeZone, now());
    const words = db.prepare('SELECT word FROM words WHERE publish_date = ? ORDER BY slot').all(t).map((r) => r.word);
    if (!words.length) return 0;
    const due = db.prepare(`SELECT DISTINCT u.* FROM users u JOIN push_subs s ON s.user_id = u.id
      WHERE u.notify_time <= ? AND (u.last_daily_push IS NULL OR u.last_daily_push < ?)`).all(clock, t);
    let sent = 0;
    for (const u of due) {
      db.prepare('UPDATE users SET last_daily_push = ? WHERE id = ?').run(t, u.id);
      const others = db.prepare(`SELECT DISTINCT u.name FROM comments c JOIN words w ON w.id = c.word_id JOIN users u ON u.id = c.user_id
        WHERE w.publish_date = ? AND c.user_id != ? ORDER BY c.created_at`).all(t, u.id).map((r) => r.name);
      let body = 'Tap to see them and add a sentence of your own.';
      if (others.length === 1) body = `${others[0]} has already commented.`;
      else if (others.length > 1) body = `${others[0]} and ${others.length - 1} other${others.length > 2 ? 's have' : ' has'} already commented.`;
      sent += await push.sendToUser(u.id, {
        title: words.length === 1 ? `Today's word: ${words[0]}` : `Today's words: ${words.join(' & ')}`,
        body, url: '/', tag: `daily-${t}`,
      });
    }
    return sent;
  }

  function notifyReply(parent, author, word) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(parent.user_id);
    if (!target || target.id === author.id || !target.notify_replies) return;
    push.sendToUser(target.id, {
      title: `${author.name} replied to you`,
      body: `On "${word.word}"`,
      url: `/#/word/${word.id}`,
      tag: `reply-${parent.id}`,
    }).catch(() => {});
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin });
  };

  route('GET', '/api/config', () => ({
    appName: config.appName,
    vapidPublicKey: push.publicKey,
    wordsPerDay: wordsPerDay(),
    colors: COLORS,
  }), { auth: false });

  route('POST', '/api/join', ({ body, req, ip }) => {
    checkAttempts(ip);
    const name = cleanText(body.name, 30, 'Name', { required: true });
    const color = COLORS.includes(body.color) ? body.color : COLORS[0];
    if (normCode(body.familyCode) !== normCode(getSetting(db, 'family_code'))) {
      failAttempt(ip);
      throw new HttpError(403, "That family code doesn't match. Check the message the link came in.");
    }
    return tx(db, () => {
      const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      let code;
      do { code = makeRejoinCode(); } while (db.prepare('SELECT 1 FROM users WHERE rejoin_code = ?').get(code));
      const id = Number(db.prepare('INSERT INTO users (name, color, rejoin_code, is_admin) VALUES (?, ?, ?, ?)')
        .run(name, color, code, isFirst ? 1 : 0).lastInsertRowid);
      const token = issueDevice(id, req);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      return { token, me: meFull(u) };
    });
  }, { auth: false });

  route('POST', '/api/rejoin', ({ body, req, ip }) => {
    checkAttempts(ip);
    const want = normCode(body.code);
    const u = want && db.prepare('SELECT * FROM users').all().find((x) => normCode(x.rejoin_code) === want);
    if (!u) {
      failAttempt(ip);
      throw new HttpError(404, "We couldn't find that code. It's on the Me screen of your old phone.");
    }
    return { token: issueDevice(u.id, req), me: meFull(u) };
  }, { auth: false });

  route('GET', '/api/me', ({ me }) => meFull(me));

  route('PATCH', '/api/me', ({ me, body }) => {
    if (body.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanText(body.name, 30, 'Name', { required: true }), me.id);
    if (body.color !== undefined) {
      if (!COLORS.includes(body.color)) throw new HttpError(400, 'Unknown colour');
      db.prepare('UPDATE users SET color = ? WHERE id = ?').run(body.color, me.id);
    }
    if (body.notifyTime !== undefined) {
      if (!isClock(body.notifyTime)) throw new HttpError(400, 'Time must look like 08:00');
      // Changing to a later time today shouldn't re-send today's notification.
      db.prepare('UPDATE users SET notify_time = ? WHERE id = ?').run(body.notifyTime, me.id);
    }
    if (body.notifyReplies !== undefined) db.prepare('UPDATE users SET notify_replies = ? WHERE id = ?').run(body.notifyReplies ? 1 : 0, me.id);
    return meFull(db.prepare('SELECT * FROM users WHERE id = ?').get(me.id));
  });

  route('POST', '/api/logout', ({ req }) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m) db.prepare('DELETE FROM devices WHERE token_hash = ?').run(hash(m[1]));
    return { ok: true };
  });

  route('GET', '/api/today', ({ me }) => {
    const t = today();
    db.prepare('INSERT OR IGNORE INTO visits (user_id, day) VALUES (?, ?)').run(me.id, t);
    const words = db.prepare('SELECT * FROM words WHERE publish_date = ? ORDER BY slot').all(t);
    return { date: t, words: words.map((w) => wordFull(w, me)), streak: streak(me.id) };
  });

  route('GET', '/api/words/:id', ({ me, params }) => wordFull(getVisibleWord(Number(params.id), me), me));

  route('POST', '/api/words/:id/reactions', ({ me, params, body }) => {
    const w = getVisibleWord(Number(params.id), me);
    if (!REACTIONS.includes(body.kind)) throw new HttpError(400, 'Unknown reaction');
    const has = db.prepare('SELECT 1 FROM reactions WHERE word_id = ? AND user_id = ? AND kind = ?').get(w.id, me.id, body.kind);
    tx(db, () => {
      if (has) {
        db.prepare('DELETE FROM reactions WHERE word_id = ? AND user_id = ? AND kind = ?').run(w.id, me.id, body.kind);
      } else {
        // "Knew it" and "New to me" are opposites: picking one clears the other.
        const opposite = { knew: 'new', new: 'knew' }[body.kind];
        if (opposite) db.prepare('DELETE FROM reactions WHERE word_id = ? AND user_id = ? AND kind = ?').run(w.id, me.id, opposite);
        db.prepare('INSERT INTO reactions (word_id, user_id, kind) VALUES (?, ?, ?)').run(w.id, me.id, body.kind);
      }
    });
    return wordFull(w, me);
  });

  route('POST', '/api/words/:id/save', ({ me, params }) => {
    const w = getVisibleWord(Number(params.id), me);
    const has = db.prepare('SELECT 1 FROM saved WHERE word_id = ? AND user_id = ?').get(w.id, me.id);
    if (has) db.prepare('DELETE FROM saved WHERE word_id = ? AND user_id = ?').run(w.id, me.id);
    else db.prepare('INSERT INTO saved (word_id, user_id) VALUES (?, ?)').run(w.id, me.id);
    return { saved: !has };
  });

  route('POST', '/api/words/:id/comments', ({ me, params, body }) => {
    const w = getVisibleWord(Number(params.id), me);
    const text = cleanText(body.body, 1000, 'Comment', { required: true });
    let parentId = null;
    let parent = null;
    if (body.parentId) {
      parent = db.prepare('SELECT * FROM comments WHERE id = ? AND word_id = ?').get(Number(body.parentId), w.id);
      if (!parent) throw new HttpError(400, 'That comment no longer exists');
      // Keep threads one level deep: replying to a reply attaches to the top comment.
      parentId = parent.parent_id || parent.id;
    }
    db.prepare('INSERT INTO comments (word_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)').run(w.id, me.id, parentId, text);
    if (parent) notifyReply(parent, me, w);
    return wordFull(w, me);
  });

  route('DELETE', '/api/comments/:id', ({ me, params }) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(params.id));
    if (!c) throw new HttpError(404, 'Comment not found');
    if (c.user_id !== me.id && !me.is_admin) throw new HttpError(403, 'You can only delete your own comments');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    return wordFull(db.prepare('SELECT * FROM words WHERE id = ?').get(c.word_id), me);
  });

  route('POST', '/api/comments/:id/like', ({ me, params }) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(params.id));
    if (!c) throw new HttpError(404, 'Comment not found');
    getVisibleWord(c.word_id, me);
    const has = db.prepare('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?').get(c.id, me.id);
    if (has) db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').run(c.id, me.id);
    else db.prepare('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)').run(c.id, me.id);
    return { liked: !has };
  });

  route('GET', '/api/archive', ({ me }) => {
    const rows = db.prepare(`
      SELECT w.id, w.word, w.definition, w.publish_date AS date,
        (SELECT COUNT(*) FROM comments c WHERE c.word_id = w.id) AS comments,
        EXISTS (SELECT 1 FROM saved s WHERE s.word_id = w.id AND s.user_id = ?) AS saved,
        EXISTS (SELECT 1 FROM reactions r WHERE r.word_id = w.id AND r.user_id = ? AND r.kind = 'new') AS newToMe
      FROM words w WHERE w.publish_date <= ? ORDER BY w.publish_date DESC, w.slot ASC`).all(me.id, me.id, today());
    return { today: today(), words: rows.map((r) => ({ ...r, saved: !!r.saved, newToMe: !!r.newToMe })) };
  });

  route('POST', '/api/push/subscribe', ({ me, body }) => {
    const s = body.subscription;
    if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || !s.keys?.p256dh || !s.keys?.auth) {
      throw new HttpError(400, 'Invalid subscription');
    }
    db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(s.endpoint, me.id, s.keys.p256dh, s.keys.auth);
    // Subscribing after today's notification time? Don't fire one straight away.
    if (localTime(config.timeZone, now()) >= me.notify_time) {
      db.prepare('UPDATE users SET last_daily_push = ? WHERE id = ?').run(today(), me.id);
    }
    return { ok: true };
  });

  route('POST', '/api/push/unsubscribe', ({ me, body }) => {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(body.endpoint || ''), me.id);
    return { ok: true };
  });

  route('POST', '/api/push/test', async ({ me }) => {
    const sent = await push.sendToUser(me.id, { title: 'Notifications are working', body: "You'll get the daily word here.", url: '/' });
    return { sent };
  });

  // ---------- admin ----------
  route('GET', '/api/admin/overview', () => {
    const t = today();
    const upcoming = db.prepare('SELECT * FROM words WHERE publish_date >= ? ORDER BY publish_date, slot').all(t);
    const lastDay = upcoming.length ? upcoming[upcoming.length - 1].publish_date : null;
    const members = db.prepare(`SELECT u.id, u.name, u.color, u.is_admin, u.created_at,
        (SELECT MAX(last_seen) FROM devices d WHERE d.user_id = u.id) AS last_seen,
        (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comments,
        (SELECT COUNT(*) FROM push_subs p WHERE p.user_id = u.id) AS push
      FROM users u ORDER BY u.created_at`).all();
    return {
      today: t,
      familyCode: getSetting(db, 'family_code'),
      wordsPerDay: wordsPerDay(),
      lastDay,
      upcoming: upcoming.map((w) => ({
        id: w.id, date: w.publish_date, slot: w.slot, word: w.word, partOfSpeech: w.part_of_speech,
        pronunciation: w.pronunciation, definition: w.definition, example: w.example, origin: w.origin, prompt: w.prompt,
      })),
      members: members.map((m) => ({ ...m, is_admin: !!m.is_admin })),
    };
  }, { admin: true });

  route('POST', '/api/admin/words', ({ body }) => {
    const w = validWordInput(body);
    const id = tx(db, () => insertWord(w));
    return { id };
  }, { admin: true });

  route('PUT', '/api/admin/words/:id', ({ params, body }) => {
    const w = validWordInput(body);
    const info = db.prepare(`UPDATE words SET word = ?, part_of_speech = ?, pronunciation = ?, definition = ?, example = ?, origin = ?, prompt = ? WHERE id = ?`)
      .run(w.word, w.part_of_speech, w.pronunciation, w.definition, w.example, w.origin, w.prompt, Number(params.id));
    if (!info.changes) throw new HttpError(404, 'Word not found');
    return { ok: true };
  }, { admin: true });

  route('DELETE', '/api/admin/words/:id', ({ params }) => {
    const w = db.prepare('SELECT * FROM words WHERE id = ?').get(Number(params.id));
    if (!w) throw new HttpError(404, 'Word not found');
    if (w.publish_date <= today()) throw new HttpError(400, "Today's and past words can't be removed: people may already be commenting. Edit it instead.");
    // Pull every later word forward one place so there's no gap in the schedule.
    tx(db, () => {
      const later = db.prepare('SELECT id, publish_date, slot FROM words WHERE (publish_date > ? OR (publish_date = ? AND slot > ?)) ORDER BY publish_date, slot')
        .all(w.publish_date, w.publish_date, w.slot);
      const places = [{ publish_date: w.publish_date, slot: w.slot }, ...later];
      db.prepare('DELETE FROM words WHERE id = ?').run(w.id);
      // Park them on temporary slots first so the (date, slot) uniqueness never clashes mid-shuffle.
      const move = db.prepare('UPDATE words SET publish_date = ?, slot = ? WHERE id = ?');
      later.forEach((x, i) => move.run(places[i].publish_date, places[i].slot + 10000, x.id));
      db.prepare('UPDATE words SET slot = slot - 10000 WHERE slot >= 10000').run();
    });
    return { ok: true };
  }, { admin: true });

  route('POST', '/api/admin/move', ({ body }) => {
    // Swap two upcoming words' places in the schedule.
    const a = db.prepare('SELECT * FROM words WHERE id = ?').get(Number(body.a));
    const b = db.prepare('SELECT * FROM words WHERE id = ?').get(Number(body.b));
    if (!a || !b) throw new HttpError(404, 'Word not found');
    const t = today();
    if (a.publish_date <= t || b.publish_date <= t) throw new HttpError(400, 'Only words from tomorrow onwards can be moved');
    tx(db, () => {
      db.prepare('UPDATE words SET publish_date = ?, slot = ? WHERE id = ?').run(a.publish_date, -1, b.id);
      db.prepare('UPDATE words SET publish_date = ?, slot = ? WHERE id = ?').run(b.publish_date, b.slot, a.id);
      db.prepare('UPDATE words SET slot = ? WHERE id = ?').run(a.slot, b.id);
    });
    return { ok: true };
  }, { admin: true });

  route('PATCH', '/api/admin/settings', ({ body }) => {
    if (body.familyCode !== undefined) {
      const code = cleanText(body.familyCode, 40, 'Family code', { required: true }).toUpperCase();
      if (normCode(code).length < 4) throw new HttpError(400, 'Family code must have at least 4 letters or numbers');
      setSetting(db, 'family_code', code);
    }
    return { familyCode: getSetting(db, 'family_code') };
  }, { admin: true });

  route('POST', '/api/admin/members/:id/remove', ({ me, params }) => {
    const id = Number(params.id);
    if (id === me.id) throw new HttpError(400, "You can't remove yourself");
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  }, { admin: true });

  // ---------- static files ----------
  const publicDir = config.publicDir;
  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const data = await readFile(file);
      const ext = path.extname(file);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // HTML, JS, CSS and the service worker always revalidate so updates reach everyone straight away.
        'Cache-Control': ['.png', '.ico', '.svg'].includes(ext) ? 'public, max-age=604800' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (ext === '.js' && rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  // ---------- request handler ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(req, res, url.pathname);
    }
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') body = await readJson(req);
      const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
      let me = null;
      if (r.auth) {
        me = authUser(req);
        if (!me) throw new HttpError(401, 'Please join first');
        if (r.admin && !me.is_admin) throw new HttpError(403, 'Admins only');
      }
      const out = await r.handler({ req, params, body, me, ip, query: url.searchParams });
      send(200, out);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: err.message });
      else { console.error(err); send(500, { error: 'Something went wrong on the server' }); }
    }
  }

  return { handle, runDailyPush, today, getFamilyCode: () => getSetting(db, 'family_code') };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

