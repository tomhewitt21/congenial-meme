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

  // Returns { sent, failed: [{ status, reason, service }] } so callers can explain what went wrong.
  async function sendToUser(userId, payload) {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(userId);
    let sent = 0;
    const failed = [];
    for (const s of subs) {
      const service = (() => { try { return new URL(s.endpoint).host; } catch { return 'unknown'; } })();
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 12, urgency: 'normal' },
        );
        sent++;
      } catch (err) {
        const status = err.statusCode || 0;
        const reason = String(err.body || err.message || '').slice(0, 300);
        failed.push({ status, reason, service });
        console.warn(`push to user ${userId} via ${service} failed: ${status} ${reason}`);
        // 404/410 mean the subscription is gone (app deleted, permission revoked).
        if (status === 404 || status === 410) {
          db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
        }
      }
    }
    return { sent, failed, devices: subs.length };
  }

  return { publicKey, sendToUser };
}
