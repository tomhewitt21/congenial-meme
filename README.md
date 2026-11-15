# Word Club

A free, self-hosted word-of-the-day app for friends and family. Everyone gets the same one or two words each morning and can comment, reply, react and look back through past words. No paywall, no App Store and no accounts to manage.

It's a web app that installs to the iPhone Home Screen and behaves like a normal app, including daily notifications (iOS 16.4 or later).

## What's in it

- **Today:** one or two words a day, each with pronunciation (tap the speaker icon to hear it), definition, example, origin and a daily challenge prompt.
- **Comments:** an always-open comment box, replies one level deep, likes, a "new" badge for comments since you last looked, and live refresh every 15 seconds.
- **Reactions:** Knew it, New to me, Love it, Will use. "Knew it" and "New to me" cancel each other out.
- **Archive:** past words grouped by week, with search and filters for "New to me" and "Saved".
- **Me:** streak, stats, notification time, name and colour, re-join code, invite sharing.
- **Admin:** the first person to join becomes the admin. The admin can add, edit, reorder and remove upcoming words, remove members and change the family code.
- **Notifications:** one at the time each person chooses (8am by default), plus one when someone replies to you.

## Sign-up and remembering devices

1. Someone opens the invite link (`https://your-site/?code=RAINY-OTTER`). On iPhone Safari they first see a short "Add to Home Screen" guide.
2. They type a name, pick a colour and confirm the family code. That's all: no email and no password.
3. The server gives that device a long random token, which the app keeps in local storage. The database stores only a hash of it. The device is then remembered from then on.
4. Each person gets a **re-join code** (e.g. `K7Q-4MX-2PD`) on the Me screen. Typing it on a new phone links that phone to the same profile.

The iPhone keeps a Home Screen app's storage separate from Safari's, which is why the guide asks people to install first and join from the Home Screen.

## Run it on your computer

Needs **Node.js 22.5 or later** (it uses Node's built-in SQLite).

```bash
npm install
FAMILY_CODE=RAINY-OTTER npm start
# → http://localhost:3000
```

The first person to join becomes the admin. Data lives in `data/wordclub.db`.

## Share it with family

Phones can only install the app and get notifications over **HTTPS**, so it needs a public `https://` address. The two easy routes:

### Option A: a spare computer or Raspberry Pi at home, plus Cloudflare Tunnel (free)

1. Install Node 22, clone this repo, then run `npm install`.
2. Start it, for example with pm2 or a systemd service:
   `FAMILY_CODE=YOUR-CODE TRUST_PROXY=1 VAPID_SUBJECT=mailto:you@example.com npm start`
3. Install `cloudflared`, then:
   - **To try it quickly:** `cloudflared tunnel --url http://localhost:3000` prints a temporary `https://….trycloudflare.com` address. It changes on every restart.
   - **To keep it:** with a domain on Cloudflare (about £8 a year), create a named tunnel so the address stays the same. Do this before inviting people, because the installed app is tied to its address.

### Option B: a small hosted server

Any host that runs Docker with a persistent disk works, such as Fly.io, Railway or a £4/month VPS. Mount a volume at `/data` and set the environment variables below.

```bash
docker build -t word-club .
docker run -p 3000:3000 -v wordclub-data:/data -e FAMILY_CODE=YOUR-CODE -e TRUST_PROXY=1 word-club
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `FAMILY_CODE` | random, printed at start-up | Code needed to join. Can also be changed in Admin |
| `APP_NAME` | `Word Club` | Name shown in the app |
| `TIME_ZONE` | `Europe/London` | Decides when "today" starts and when notifications go out |
| `WORDS_PER_DAY` | `2` | Words per day (used on first start) |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `VAPID_SUBJECT` | `mailto:wordclub@example.com` | Contact for push services. **Set this to your own email** or Apple may reject notifications |
| `TRUST_PROXY` | off | Set to `1` behind Cloudflare, nginx, Caddy etc. so rate-limiting sees real IPs |

## Words

The app comes with 40 hand-written words (20 days at two a day), loaded on first start. Add more in **Me → Admin → Add a word**. New words go to the end of the queue. The admin screen warns you when the queue is about to run out. Today's and past words can be edited but not moved or removed, because people may already be commenting on them.

## Backups

Everything is in one file: `data/wordclub.db`. Copy it somewhere safe now and then. Copying while the server is running is fine.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API tests (in-memory database, fake clock)
```

- `server/`: plain Node HTTP server, SQLite, web-push. Its only dependency is `web-push`.
- `public/`: the app itself. Plain HTML, CSS and JavaScript, no build step. `sw.js` handles offline use and notifications.
