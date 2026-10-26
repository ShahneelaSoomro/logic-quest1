# Logic Quest: Circuit Arcade

Your game plus a production-ready backend. **Zero npm dependencies**, SQLite storage, needs only Node 22.5+ (or Docker).

```
logic-quest/
├─ public/
│  ├─ index.html          your game (only 2 small edits: loads the adapter, new offline message)
│  └─ js/lq-backend.js    adapter: gives the game its `claude.use("user"|"db"|"downloads")` API, backed by this server
├─ server.js              HTTP server: static files + REST API + security headers + rate limiting
├─ db.js                  SQLite layer (users, sessions, profiles, items)
├─ test/api.test.js       14 automated tests  (npm test)
├─ Dockerfile  render.yaml  railway.json  .env.example
└─ package.json
```

## Run locally
```bash
node -v        # must be 22.5 or newer
npm start      # http://localhost:3000
npm test
```

## What the backend does
Players need no sign-up. The first visit creates an anonymous guest account (HttpOnly cookie, token stored hashed).
Progress, points, stars, badges, custom challenges and history are saved server-side and survive across visits.
If the server is unreachable the game falls back to browser `localStorage`, exactly as before.

| Endpoint | Purpose |
|---|---|
| `POST /api/session` | create/resume guest account |
| `GET/PUT /api/profile` | points, stars, progress, name |
| `GET /api/c/{badges\|custom\|history}` | list |
| `PUT/DELETE /api/c/{sub}/{id}` | save / delete one item |
| `GET /api/leaderboard` | top 20 (name + points only) |
| `DELETE /api/account` | erase all of a player's data |
| `GET /health` | uptime check |

## Deploy
**Important:** the database is a file, so your host must give the app a **persistent disk/volume** mounted at `DATA_DIR`.
Without one, data is lost on every redeploy.

- **Render:** push to GitHub, then New > Blueprint (uses `render.yaml`). Persistent disks need a paid instance.
- **Railway:** New Project > Deploy from GitHub. Add a Volume mounted at `/data` and set `DATA_DIR=/data`, `COOKIE_SECURE=true`.
- **Fly.io:** `fly launch`, then `fly volumes create lq_data --size 1`, mount at `/data`, set the env vars above.
- **Any VPS:** `docker build -t logic-quest . && docker run -d -p 80:3000 -v lq-data:/data -e COOKIE_SECURE=true logic-quest` (put it behind HTTPS).

Set `COOKIE_SECURE=true` whenever you serve over HTTPS.

## Push to GitHub
```bash
cd logic-quest
git init -b main && git add . && git commit -m "Logic Quest with backend"
git remote add origin https://github.com/<you>/logic-quest.git
git push -u origin main
```

## GitHub Pages
Pages hosts static files only, so `server.js` cannot run there. Two options:

**A) Pages only (no server).** Game works fully; progress is saved in each player's own browser.
1. Push to GitHub (`main` branch).
2. Repo > Settings > Pages > Source: **GitHub Actions**.
3. The included workflow `.github/workflows/pages.yml` publishes `public/` on every push.
   Live at `https://<you>.github.io/<repo>/`.

**B) Pages + external backend (progress saved server-side).**
1. Deploy this repo to Render/Railway/Fly (see Deploy above) and set `CORS_ORIGINS=https://<you>.github.io`.
2. Edit `public/js/config.js`: `window.LQ_API_BASE = "https://your-app.onrender.com";`
3. Commit and push. Pages redeploys automatically.

## Notes
- Scores are saved from the browser, so the leaderboard is honor-system (fine for a classroom/arcade game, not for prizes).
- Guest accounts are tied to one browser's cookie. Clearing cookies starts a fresh account. Cross-device login would need email/password or OAuth (can be added).
- To host the frontend on a different domain, set `CORS_ORIGINS` and serve over HTTPS with `SameSite=None` cookies.
