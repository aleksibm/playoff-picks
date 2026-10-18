# The Playoff Pick

Two independent NHL games with a shared account: Playoff Pick predictions and a six-player Fantasy competition. Each game has its own entries, points and leaderboard. The app runs locally by default and supports public HTTPS hosting behind a reverse proxy.

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

## Fantasy at `/fantasy`

- Choose **1 goalie, 2 defensemen and 3 attackers**, starting with **US$40 million**. Attackers can be centers or either wing. There are no mandatory price tiers. After entry, sales credit the player's current market price and purchases deduct the current price. Unspent cash is durable and does not rise when held players appreciate. A team's value can grow beyond $40 million. Draft edits only preview trades; confirmation settles all sales and purchases atomically. Every transaction records the market version, prices and cash before/after. A changed market quote requires a new review.
- Starting prices use the agreed 2025–26 backtest, at US$16,092.626542642727 per fantasy point. The shipped catalog has 1,016 players with positive, verified valuations; rookies and players without a usable valuation are not selectable in this edition. Prices update each Monday at noon Helsinki time. The target blends 75% of last-season points with 25% of current-season points per appearance projected to 82 skater appearances or 55 goalie appearances, converted at the agreed dollar rate. Each move is capped at ±5% of the previous weekly price, rounded inward to whole dollars. Prices wait for five appearances, and players with pending GSAx keep their verified price. Failed or stale stats never move prices. Missed weeks catch up with one capped adjustment.
- Drafts save to the account. Entering the first team uses no transfers. After entry, **each replacement costs one of two transfers per Helsinki calendar month**. Unused transfers expire; the next month always starts with two. The server validates the budget, position counts, monthly limit and revision atomically.
- Fantasy uses the existing account and cookie, but stores independent draft, active lineup, cash and lineup history records. Entering Fantasy does not enter or unlock Playoff Pick. Guests see a signup prompt, then the picker appears after login. A submitted Fantasy team is required to reveal the Fantasy leaderboard and other managers' rosters; guest and unsubmitted API responses contain no entries. The large introductory banner has been removed.
- Only **completed 2026–27 regular-season games that start after entry** score. Transfers apply to games starting after confirmation. Previously earned points remain with the team, including contributions by transferred-out players. Game start and transfer timestamps are compared as instants, including milliseconds.
- The half-rink team sheet puts attackers across the front, defensemen behind them, and the goalie in the crease. The market supports search, position and budget filters, and price/current-points sorting.

### Fantasy scoring

Non-power-play goals earn 5 and assists 10/3. Power-play goals and assists earn two-thirds of those values. A game-winning goal earns 6.25 total goal points in any situation. Defensemen receive 1.5 times goal and assist points, including the game-winner award. All other categories have the same value for every skater: faceoffs +1 won/−1 lost; shots, hits, blocks and takeaways +0.25 each; giveaways zero; and team wins +5 for players who appeared.

Each 2-minute minor or 4-minute double minor deducts 5/3; a 5-minute major deducts 10/3; misconducts and match ejections deduct 5. Separate penalties stack. Unassigned team or coach penalties are not charged to a player serving a bench penalty.

Goalies earn 0.625 per save and lose 3.75 per goal conceded. An official individual shutout multiplies that game's save points by 1.5. Goals saved above expected (GSAx) add or deduct 5 per expected goal prevented. Goalies also receive forward-rate goals/assists, the same penalty deductions, and +5 for appearing in a team win, including relief appearances. Shootout attempts do not score.

Fantasy statistics are fetched **once daily at 12:00 Europe/Helsinki**, alongside the independent standings refresh, with startup catch-up after downtime. Browser requests read the cached snapshot and do not fetch upstream statistics. The Fantasy page refreshes its displayed statistics once per day, or when the user explicitly refreshes the table. Focus reconciles account state and cached prices. Weekly prices are changed only by the backend using a verified, current statistics snapshot.

Sources are official NHL per-game reports and event feeds, plus [MoneyPuck.com's published goalie game data](https://moneypuck.com/data.htm). MoneyPuck data is used with attribution for this noncommercial game. Missing model data is explicitly marked provisional in player totals, team scores and the leaderboard. Unverified feeds never replace a verified snapshot. NHL event manpower placeholders are reconciled with official per-game power-play totals.

Fantasy uses SQLite schema version 4 while preserving existing accounts, sessions and prediction records. Back up the private data directory before deploying. The new backend is required: deploying `dist/` alone cannot save teams or enforce transfers. Optional setting: `PLAYOFF_PICK_FETCH_FANTASY=0` disables upstream Fantasy updates for isolated previews.

## Player value at `/fantasy/value`

The public value board compares the current fantasy market price with the full 2026–27 annual contract cap hit. It sorts by the signed dollar difference by default; percentage difference, lowest difference, fantasy price and contract price are also available. Filters cover position, team and player search. Unmatched contracts are excluded by default and can be included without inventing zero-dollar contracts or differences.

The initial 18 October 2026 snapshot matches 939 of the 1,016 fantasy players. Contract facts are credited and linked to [PuckPedia](https://puckpedia.com/), whose [reuse statement](https://puckpedia.com/contact) permits credited, linked use. The source player URL is matched to a specific NHL ID; nickname aliases and same-name players were reviewed rather than fuzzily joined. Full contract cost includes salary retained by other teams and excludes potential performance bonuses, buried-cap relief, buyouts and total multi-year contract value. Each record keeps its player and team source links.

Salary refreshes are scheduled for **25 September and 25 October at 12:00 Europe/Helsinki**. A missed date catches up once at startup. There is one source attempt per scheduled period, persisted in `contract-values.json`, with no daily upstream requests or repeated retries on restart. Updates use fixed public PuckPedia team URLs, bounded responses, timeouts, current-season checks, identity checks and all 32 teams. Failed or incomplete updates keep the last verified snapshot, expose the dated snapshot and refresh error, and do not substitute salary estimates. `PLAYOFF_PICK_FETCH_CONTRACTS=0` disables scheduled source requests.

**Source availability:** direct public-page requests received a Cloudflare 403 challenge during local verification. The shipped snapshot was verified through the normal public browser pages. Scheduled refreshes safely retain that snapshot if blocked; successful automatic salary updates on the hosting machine are not yet confirmed. A verified replacement `player-contracts.json` can be shipped with a newer `asOf` date and loaded on restart. Do not bypass the source's access controls.

Keep `market-prices.json`, `contract-values.json`, the score caches and `accounts.sqlite` together when backing up the private data directory. Schema 3 teams migrate with their original unused cash preserved. An invalid weekly price cache blocks startup rather than resetting prices and allowing trades against fabricated values. Rolling back the backend requires restoring its matching pre-upgrade database and private-data backup.

## Playoff Pick scores

The leaderboard sums the official NHL **regular-season standings points** of the 16 selected teams. Full-season totals are used, including games before a prediction was submitted. Scores use the NHL's actual points field, including any rule-specific adjustments, rather than goals scored or playoff results.

Official standings are fetched **daily at 12:00 in Europe/Helsinki**, with Finnish daylight saving time handled automatically. The host computer must be awake and the backend running. A delayed timer fetches once when it resumes; a missed update while the app was stopped is fetched at the next startup. Startup also fetches initial data when no verified cache exists, and otherwise keeps the cache from the most recent scheduled update. The admin page shows the next scheduled update and retains its manual refresh button.

The browser refreshes the leaderboard every minute while the page is visible, reading the backend's cached points. Equal totals share a rank (1, 1, 3). NHL data must identify season 20262027 and contain all 32 current teams; another season is never substituted.

If the feed is unavailable, the last verified data is used with a warning. If there is no verified data, points and ranks are shown as unavailable, never fabricated.

Source: https://api-web.nhle.com/v1/standings/now

Scoring explanation: https://www.nhl.com/kraken/news/understanding-nhl-standings-and-points-313505214

## Local storage

Accounts, password hashes, sessions, predictions, fantasy cash balances, trade records, weekly market prices, salary snapshots, and verified score caches live under **.local-data/**. This directory is private local data and is excluded from Git and exported source archives. Keep a backup of it to preserve accounts and predictions. Stop the app before copying the whole directory for a consistent backup.

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
