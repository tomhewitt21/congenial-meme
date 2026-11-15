import webpush from 'web-push';
import { getSetting, setSetting } from './db.js';

// Web Push needs a VAPID key pair. We create one the first time the server
// runs and keep it in the database, so existing subscriptions keep working.
export function setupPush(db, subject) {
  let publicKey = getSetting(db, 'vapid_public');
  let privateKey = getSetting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  async function sendToUser(userId, payload) {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(userId);
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 12 },
        );
        sent++;
      } catch (err) {
        // 404/410 mean the subscription is gone (app deleted, permission revoked).
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
        } else {
          console.warn(`push to user ${userId} failed:`, err.statusCode || err.message);
        }
      }
    }
    return sent;
  }

  return { publicKey, sendToUser };
}
