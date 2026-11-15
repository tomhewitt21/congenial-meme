import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { setupPush } from './push.js';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  port: Number(process.env.PORT || 3000),
  appName: process.env.APP_NAME || 'Word Club',
  timeZone: process.env.TIME_ZONE || 'Europe/London',
  wordsPerDay: Number(process.env.WORDS_PER_DAY || 2),
  familyCode: process.env.FAMILY_CODE || '',
  dataDir: path.resolve(root, process.env.DATA_DIR || 'data'),
  publicDir: path.join(root, 'public'),
  // Apple requires a real contact here: a mailto: address or your site's https URL.
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:wordclub@example.com',
  // Set TRUST_PROXY=1 when running behind Cloudflare Tunnel, Caddy, nginx etc.
  trustProxy: process.env.TRUST_PROXY === '1',
};

const db = openDb(config.dataDir);
const push = setupPush(db, config.vapidSubject);
const app = createApp({ db, config, push });

const server = http.createServer((req, res) => { app.handle(req, res); });
server.listen(config.port, () => {
  console.log(`${config.appName} is running on http://localhost:${config.port}`);
  console.log(`Family code: ${app.getFamilyCode()}   (change it in the app: Me → Admin → Family code)`);
  console.log(`Time zone: ${config.timeZone}. The first person to join becomes the admin.`);
});

// Check every minute whether anyone's daily notification is due.
setInterval(() => {
  app.runDailyPush().catch((err) => console.error('daily push failed:', err));
}, 60 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
