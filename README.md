# HotelOps — Hospitality Control Console

Offline-first progressive web app for hotel operations: room board, sessions, charges, revenue analytics, and historical replay (Nexus).

## Quick Start

This app uses IndexedDB and a service worker. **Do not open `index.html` directly** — serve the folder over HTTP:

```bash
npx serve .
```

Then open the URL shown (e.g. `http://localhost:3000`).

Alternative:

```bash
python -m http.server 8080
```

## Deployment

### Netlify (Recommended)

1. Push your code to a Git repository (GitHub, GitLab, or Bitbucket)
2. Go to [Netlify](https://app.netlify.com) and click "Add new site"
3. Connect your Git repository
4. Netlify will auto-detect the configuration from `netlify.toml`
5. Click "Deploy site"

The `netlify.toml` file includes:
- SPA routing (all routes redirect to `index.html`)
- Asset optimization (minification, bundling)
- Security headers
- Cache control for static assets
- Service Worker configuration

### Manual Deployment

You can also deploy manually by dragging and dropping the folder to Netlify's dashboard.

## Demo Access Codes

| Code | Role | Access |
|------|------|--------|
| `STAFFINV` | Staff | Rooms board + Staff Console |
| `FOUNDINV` | Founder | Full dashboard + settings |
| `ADMININV` | Admin | Full dashboard + settings |

Tap a demo chip on the lock screen, or type an 8-character code manually.

Rotated codes in **Settings → Access Codes** take effect immediately for new device activations. Demo aliases always work.

Default rotatable codes (before rotation): `STAFF1234`, `FOUND5678`, `ADMIN9012`.

## First-Run Walkthrough

1. Serve the app and open it in a browser.
2. Enter `FOUNDINV` to unlock as Founder.
3. **Room Board** — 12 rooms with live seeded sessions (try Room **203**).
4. Click a room → **Charges** tab → add a Spa charge → **Confirm** within 5 minutes.
5. **Command palette** — `Ctrl+K` (or `Cmd+K` on Mac) for quick navigation.
6. **Nexus** — drag the time slider to replay hotel state.
7. **Settings → Rooms** — rename, add (e.g. 401), or remove vacant rooms.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Open command palette |
| `Ctrl/Cmd + R` | Rooms board |
| `Ctrl/Cmd + F` | Revenue (founder/admin) |
| `Ctrl/Cmd + N` | Nexus replay (founder/admin) |
| `Ctrl/Cmd + A` | Audit log (founder/admin) |
| `Ctrl/Cmd + L` | Lock application |
| `Ctrl/Cmd + Shift + +` | New check-in session |

## Tech Stack

- Vanilla HTML / CSS / JavaScript (no build step)
- IndexedDB event store with projections
- Optional Supabase cloud sync — configure in `supabase.js`

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `index.css` | Design system + animated backgrounds |
| `app.js` | UI controller |
| `db.js` | Event store, projections, seed data |
| `supabase.js` | Optional cloud sync |
| `sw.js` | Service worker / offline cache |
