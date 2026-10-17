# The Playoff Pick

An NHL playoff prediction game with accounts, locked predictions, and a live season leaderboard. It runs locally by default and supports public HTTPS hosting behind a reverse proxy.

For your Linux hosting laptop and **picks.aleksi.net through Cloudflare Tunnel**, follow **[HOSTING.md](HOSTING.md)**. The security review and its verification limits are in **[SECURITY-REVIEW.md](SECURITY-REVIEW.md)**. Transfer the prepared source ZIP; keep private account data separate.

## Open the app

On this Mac, double-click **Start Playoff Pick.command**, then visit **http://127.0.0.1:8765/**. Keep its terminal window open while using the app; press Control-C to stop it.

Use the latest security-patched Node.js 24 LTS. The Mac launcher finds an installed Node.js or this computer's bundled Codex runtime. No npm packages are needed. On Linux, run `sh deployment/start.sh` for a local preview; use the systemd service in the hosting guide for public hosting.

Alternatively, run `node server.mjs` in this folder.

Opening an HTML file directly cannot provide account storage or the shared leaderboard. The previous **Playoff Pick.html** and **Playoff Pick.zip** are retained as the earlier offline version; use the server for the updated app.

## Accounts and predictions

- Create a username and a password of at least 7 characters, or log back in. Existing accounts keep their current passwords.
- Guests use **Choose your teams** to create an account, or **Log in** to return to an existing account. The team picker appears after sign-in, and draft picks automatically save to the account.
- Pick 16 teams: eight per conference, with at least three and at most five from each division.
- Submit the completed prediction to join the leaderboard. The prediction is permanently locked for this season.
- The leaderboard and other players' picks unlock only after submitting your own complete prediction. Guests, unfinished picks, and complete but unsubmitted drafts cannot view entries. The backend enforces this for leaderboard requests; shared-prediction links follow the same rule in the UI.
- Each account has one leaderboard entry for the 2026–27 season.
- Logging out does not remove the account or its prediction.

## Scores

The leaderboard sums the official NHL **regular-season standings points** of the 16 selected teams. Full-season totals are used, including games before a prediction was submitted. Scores use the NHL's actual points field, including any rule-specific adjustments, rather than goals scored or playoff results.

Official standings are fetched **daily at 12:00 in Europe/Helsinki**, with Finnish daylight saving time handled automatically. The host computer must be awake and the backend running. A delayed timer fetches once when it resumes; a missed update while the app was stopped is fetched at the next startup. Startup also fetches initial data when no verified cache exists, and otherwise keeps the cache from the most recent scheduled update. The admin page shows the next scheduled update and retains its manual refresh button.

The browser refreshes the leaderboard every minute while the page is visible, reading the backend's cached points. Equal totals share a rank (1, 1, 3). NHL data must identify season 20262027 and contain all 32 current teams; another season is never substituted.

If the feed is unavailable, the last verified data is used with a warning. If there is no verified data, points and ranks are shown as unavailable, never fabricated.

Source: https://api-web.nhle.com/v1/standings/now

Scoring explanation: https://www.nhl.com/kraken/news/understanding-nhl-standings-and-points-313505214

## Local storage

Accounts, password hashes, sessions, predictions, and the verified standings cache live under **.local-data/**. This directory is private local data and is excluded from Git and exported source archives. Keep a backup of it to preserve accounts and predictions. Stop the app before copying the whole directory for a consistent backup.

Passwords use salted scrypt hashes with bounded authentication work. Older password hashes upgrade on a successful login. Sessions use opaque tokens in HttpOnly, SameSite cookies; public hosting additionally uses HTTPS-only Secure cookies with the `__Host-` prefix. Server-side authorization, CSRF checks, and revision checks protect account-owned writes and submitted predictions.

Both Node listeners stay bound to 127.0.0.1. The supplied public setup uses `PLAYOFF_PICK_PUBLIC_ORIGIN=https://picks.aleksi.net`, `PLAYOFF_PICK_PROXY=cloudflare-tunnel`, and a named Cloudflare Tunnel. It validates the exact public Host and Origin and uses Cloudflare's edge visitor-IP header for rate limits. No inbound router ports are required. The old Sites static manifest is retained as historical project identity; publishing `dist/` alone will not provide the account backend.

No email/password-recovery service is configured. Submitted usernames, selected teams, and scores are visible to players who have submitted their own prediction; saved drafts are private to the account. Guests' drafts are stored on their own browser. Google Fonts supplies typography; team logos are served locally.

## Administration on the hosting computer

With the app running, open **http://127.0.0.1:8766/** directly on the computer running the server. The launcher starts this dashboard alongside the player site.

The dashboard shows account counts, saved drafts, locked submissions, selected teams and scores, and the NHL feed status. You can search accounts, inspect a prediction, reload the overview, or fetch the latest NHL standings. Select a player to change their displayed/login name, set a new password, or reset their selections. Password resets revoke all of that player's sessions. Resetting selections clears their draft or locked prediction, removes them from the leaderboard, and lets them choose again; a confirmation dialog describes this before applying it. Old prediction revisions cannot overwrite a reset. Account deletion is not offered, and password hashes and sign-in tokens are never displayed.

Administration has a separate listener bound exclusively to **127.0.0.1**. Admin pages and APIs are not served on the player site's port. Requests with foreign addresses, origins, fetch metadata, or proxy headers are rejected; manual refresh also requires a page-specific CSRF token. Anyone using the hosting computer can open the dashboard without a separate admin login.

Keep port 8766 private: never forward it through a tunnel or reverse proxy. The supplied tunnel exposes only the player site. On the Linux laptop, open the administration URL directly in its browser.

## Files

- `server.mjs`: loopback server and player API
- `hosting.mjs`: local/public origin checks, proxy validation, and bounded rate limits
- `accounts.mjs`: durable accounts, sessions, drafts, and locked predictions
- `admin.mjs`: separate host-only administration listener and access checks
- `schedule.mjs`: daily Helsinki-noon scheduling and daylight saving handling
- `standings.mjs`: verified NHL standings and leaderboard scoring
- `dist/`: responsive frontend and team/picking engine
- `dist/logos/`: locally stored official NHL team logos; source URLs are recorded in its README
- `tests/`: picking, account, scoring, and HTTP integration tests
- `deployment/`: Linux service, Cloudflare Tunnel, preflight, startup, and backup templates

Run checks with `node --test tests/*.test.mjs`.

Settings: `PLAYOFF_PICK_PUBLIC_ORIGIN` for public HTTPS mode; `PLAYOFF_PICK_PROXY=cloudflare-tunnel` for the supplied hosting setup (`caddy` is also supported); `PLAYOFF_PICK_PORT`; `PLAYOFF_PICK_ADMIN_PORT` (default 8766; must differ from the player port); `PLAYOFF_PICK_DATA_DIR`; and `PLAYOFF_PICK_FETCH_STANDINGS=0` to disable external standings requests. `NODE_ENV=production` refuses startup without an HTTPS public origin. Both listening addresses are fixed to loopback.
