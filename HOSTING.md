# Host The Playoff Pick at picks.aleksi.net

This setup publishes **https://picks.aleksi.net** through a Cloudflare Tunnel on your Linux laptop. The Node backend and its separate admin dashboard stay on `127.0.0.1`. The tunnel exposes only the player website; accounts and predictions stay in the laptop's private database.

The source package is prepared for this setup. The laptop, domain, and tunnel still need the installation and live checks below. Real tunnel credentials are created on the laptop and are excluded from the source package.

## 1. Prepare Linux and copy the app

Use a supported Linux distribution with systemd. These commands use Debian/Ubuntu conventions. Install the **latest security-patched Node.js 24 LTS** from the [official Node downloads](https://nodejs.org/en/download), and install `cloudflared` with [Cloudflare's official Linux instructions](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/). Use a system-wide Node binary that systemd can run without a personal shell or version manager. No `npm install` is needed; the app has no third-party runtime dependencies.

```sh
node --version
command -v node
cloudflared --version
```

Node must report `v24.x`. The service assumes `/usr/bin/node`. Change both Node paths in `deployment/playoff-picks.service` if your system-wide binary is elsewhere.

Transfer and extract the source ZIP into a temporary folder on the laptop. From that folder, install the app:

```sh
sudo useradd --system --user-group --home-dir /var/lib/playoff-picks --shell /usr/sbin/nologin playoff-pick
sudo install -d -m 0755 /opt/playoff-picks
sudo cp -R dist deployment tests /opt/playoff-picks/
sudo cp ./*.mjs fantasy-players.json fantasy-roster.json player-contracts.json package.json README.md HOSTING.md SECURITY-REVIEW.md /opt/playoff-picks/
sudo chown -R root:root /opt/playoff-picks
sudo find /opt/playoff-picks -type d -exec chmod 0755 {} +
sudo find /opt/playoff-picks -type f -exec chmod 0644 {} +
sudo install -d -o playoff-pick -g playoff-pick -m 0700 /var/lib/playoff-picks
```

Run `useradd` only if this account does not already exist. Root owns the application files; the app runs as the unprivileged `playoff-pick` account and stores private data separately. Scripts run through `sh`, so executable permissions are unnecessary.

For a local trial in the extracted folder, run `sh deployment/start.sh` and visit `http://127.0.0.1:8765/`. Stop that server before starting systemd. Two servers must not share the same database.

Keep the laptop plugged in, awake, and connected. Configure its power settings so closing the lid does not suspend the server, and enable accurate network time. Both the backend and tunnel need to be running for the public website to work.

## 2. Check and start the backend

The supplied environment already uses `https://picks.aleksi.net` and `PLAYOFF_PICK_PROXY=cloudflare-tunnel`. Keep the origin identical to the public hostname, with no trailing slash, path, credentials, or custom port.

```sh
sudo install -o root -g root -m 0600 deployment/playoff-picks.env.example /etc/playoff-picks.env
sudo install -o root -g root -m 0644 deployment/playoff-picks.service /etc/systemd/system/playoff-picks.service
sudo systemctl daemon-reload
cd /opt/playoff-picks
node --test tests/*.test.mjs
sudo /usr/bin/node --env-file=/etc/playoff-picks.env deployment/check.mjs --production
sudo systemd-analyze verify /etc/systemd/system/playoff-picks.service
sudo systemctl enable --now playoff-picks
sudo systemctl status playoff-picks
```

Use the Node path chosen in step 1 for the preflight command, and start only after checks pass. The service starts at boot, restarts after a failure, and uses restrictive permissions and resource limits. `NODE_ENV=production` requires a valid HTTPS origin. Private data lives under `/var/lib/playoff-picks`, with owner-only access.

Before connecting the tunnel, confirm the backend with this read-only request on the hosting laptop:

```sh
curl --fail http://127.0.0.1:8765/api/health \
  -H 'Host: picks.aleksi.net' \
  -H 'X-Forwarded-Proto: https' \
  -H 'CF-Connecting-IP: 127.0.0.1'
```

The real tunnel supplies these headers. The backend rejects wrong Host values, insecure protocol, and missing or invalid visitor IPs. Direct browser visits to player port 8765 are rejected in public mode; use the domain after the tunnel is running. Local admin port 8766 keeps working directly on the hosting laptop.

## 3. Prepare the aleksi.net zone in Cloudflare

Add **aleksi.net** to your Cloudflare account if necessary, and set the domain's nameservers to the Cloudflare nameservers assigned to its zone. The site uses the **picks** subdomain inside this zone; do not add `picks.aleksi.net` as a separate zone. Wait for the zone to become active. Review existing records during migration and preserve mail-related MX/TXT records and unrelated services. [Cloudflare tunnel prerequisites](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)

In the dashboard for the **aleksi.net** zone:

- Under **SSL/TLS → Edge Certificates**, enable **Always Use HTTPS**, keep SSL/TLS enabled, and wait for the edge certificate to become active. This redirects HTTP visitors before requests reach the backend. [HTTPS setting](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
- Under **Caching → Cache Rules**, deploy a required **Bypass cache** rule for **Hostname equals picks.aleksi.net AND URI Path starts with /api/**. Its expression is `(http.host eq "picks.aleksi.net" and starts_with(http.request.uri.path, "/api/"))`. Ensure no later rule overrides it. Never apply Cache Everything or an Edge TTL override to `/api/*`; account responses and leaderboard JSON must reach the backend. For the initial launch, you may also bypass caching for the whole hostname. [Cache rule instructions](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)
- Keep **Remove visitor IP headers** disabled. Keep **Pseudo IPv4** off or use its header-addition mode. Do not put same-zone Workers or header transforms in front of the site that rewrite the visitor IP or protocol.

The backend uses Cloudflare's `CF-Connecting-IP` visitor address and `X-Forwarded-Proto` protocol in tunnel mode, ignoring arbitrary `X-Forwarded-For` chains. Cloudflare replaces the incoming protocol header; Worker subrequests can change visitor-IP behavior, so adding one requires a new review. [Cloudflare request header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

## 4. Create and connect the named tunnel

On the Linux laptop, as your normal user:

```sh
cloudflared tunnel login
cloudflared tunnel create playoff-picks
cloudflared tunnel list
```

Authorize the Cloudflare account for the **aleksi.net** zone. Creation prints a UUID and writes the tunnel's private `<UUID>.json` file under your user's `.cloudflared` directory. Keep `cert.pem` and the JSON private; do not paste them into chat, commit them, or add them to the source ZIP. The account certificate manages tunnels; the service uses its tunnel-specific JSON. [Tunnel creation guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)

In the extracted app folder, edit `deployment/cloudflared.yml.example` and replace **TUNNEL_UUID** in both locations with that UUID. Keep **hostname: picks.aleksi.net**, **service: http://127.0.0.1:8765**, and **originRequest.httpHostHeader: picks.aleksi.net**. The final rule returns a 404 for unmatched hostnames. Never add an ingress route to admin port 8766. [Origin Host parameter](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#httphostheader)

Replace `YOUR_TUNNEL_UUID` below with the UUID you just created:

```sh
chmod 0700 "$HOME/.cloudflared"
chmod 0600 "$HOME/.cloudflared/cert.pem" "$HOME/.cloudflared/YOUR_TUNNEL_UUID.json"
sudo install -d -o root -g root -m 0700 /etc/cloudflared
sudo install -o root -g root -m 0600 "$HOME/.cloudflared/YOUR_TUNNEL_UUID.json" /etc/cloudflared/YOUR_TUNNEL_UUID.json
sudo install -o root -g root -m 0600 deployment/cloudflared.yml.example /etc/cloudflared/config.yml
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://picks.aleksi.net/
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://unmatched.example/
```

The rule check must select the player service for picks.aleksi.net and the catch-all 404 for the unmatched hostname. These checks do not open a public connection. [Ingress validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)

Create the DNS route as your normal user:

```sh
cloudflared tunnel route dns playoff-picks picks.aleksi.net
```

This creates the **picks** DNS record in the **aleksi.net** zone and points `picks.aleksi.net` at the tunnel. If an existing A, AAAA, or CNAME record for `picks` conflicts, check what it serves before replacing only that subdomain record. Preserve the main `aleksi.net` website, mail, and other DNS records.

Install the Linux tunnel service with its explicit configuration path:

```sh
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared playoff-picks
```

If another tunnel already uses the cloudflared service on this laptop, review its existing configuration first. The explicit config path avoids relying on the normal user's home directory under sudo. [Cloudflare Linux service instructions](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/linux/)

## 5. Network and live checks

Cloudflare Tunnel connects outwards, so **no router port forwarding or public home IP is needed**. Do not open inbound ports 8765 or 8766. This setup also does not require inbound 80 or 443 on the laptop.

If outgoing traffic is restricted, allow tunnel connections on **7844 TCP/UDP** for HTTP/2 and QUIC. Keep outbound HTTPS **443** available for authorization, updates, and the NHL feed, plus DNS to your resolver, usually **53 TCP/UDP**. Use Cloudflare's current destination list if your firewall restricts endpoints. [Tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

From another device or a mobile connection:

```sh
curl --fail https://picks.aleksi.net/api/health
curl -I http://picks.aleksi.net/
curl -I https://picks.aleksi.net/
curl -sS -D - -o /dev/null https://picks.aleksi.net/api/session
```

Expect successful health, an HTTP redirect to HTTPS, and a valid certificate. The session response must include `Cache-Control: no-store` and must not show a Cloudflare cache **HIT**. In a browser, register a test account, save a draft, log out and back in, and submit a complete 16-team prediction. Confirm it reaches the leaderboard, remains locked, and survives `sudo systemctl restart playoff-picks`. Use a dedicated test account because submission is permanent for this season.

On the laptop, run `sudo ss -ltnp`. Backend and admin must show **127.0.0.1:8765** and **127.0.0.1:8766**. Another device must not connect to either through the laptop's network address. Public requests to `/admin` and `/api/admin/overview` on picks.aleksi.net must fail; admin pages and APIs belong only to the separate local listener.

Use `sudo journalctl -u playoff-picks -u cloudflared --since today` to diagnose failures. Keep credentials and logs private. Restart cloudflared after configuration changes. Enable Cloudflare account MFA and store recovery codes securely.

## 6. Administration, scores, and backups

On the hosting laptop, open **http://127.0.0.1:8766/**. People using the hosting computer can access this dashboard without a separate admin password, so lock the laptop when unattended. It is excluded from the tunnel.

Select an account in the table to open its inspector and management controls. **Change name** updates both the displayed name and login username. **Reset password** sets a new 7–128-character password and signs that player out everywhere. **Reset selections** clears their picks, unlocks any submitted prediction, and removes their leaderboard entry until they submit again. Each action identifies the selected player in a confirmation dialog. Account changes require the local page's Origin and CSRF token; these endpoints do not exist on the public player port. The dashboard does not display existing passwords or offer account deletion.

The backend gets verified NHL standings daily at **12:00 Europe/Helsinki**, including daylight saving changes. It fetches initial data and catches up after a missed update; no separate cron job is needed. The admin page shows the next update and any stale or unavailable data. Feed outages retain the last verified scores. The game currently uses the **2026–27 regular season**; future seasons require a verified code/configuration update.

The source ZIP excludes accounts and sessions. To preserve existing local accounts, stop the app on this Mac and privately transfer the complete `.local-data` directory, including SQLite WAL/SHM files if present. Stop the Linux service before putting those files in `/var/lib/playoff-picks`. Back up any existing hosting data first. Never combine account databases.

After restoring data:

```sh
sudo chown -R playoff-pick:playoff-pick /var/lib/playoff-picks
sudo chmod 0700 /var/lib/playoff-picks
sudo find /var/lib/playoff-picks -type f -exec chmod 0600 {} +
sudo systemctl start playoff-picks
```

For a consistent Linux backup:

```sh
sudo sh /opt/playoff-picks/deployment/backup.sh
sudo systemctl status playoff-picks
```

The script stops the app, archives its whole private data directory under `/var/backups/playoff-picks`, creates a SHA-256 checksum, and restarts the app if it was running. It attempts to restart even if copying fails. Backups briefly interrupt the site and never remove previous archives; monitor disk space. Do not restore interrupted `.partial` files.

Keep encrypted backups on a separate device. They contain password hashes and sessions. From the archive directory, check `sha256sum -c backup-file.tar.gz.sha256` and test restoration into an empty folder. To restore live data, stop the service, preserve existing data separately, and extract a trusted verified archive into an empty `/var/lib/playoff-picks`. Set the permissions above before restarting. Never extract an untrusted archive as root. Securely back up Cloudflare tunnel credentials separately; the app's backup does not include them.

## Update an existing installation from GitHub

Once `deployment/update.sh` is installed, run this on the hosting laptop for
each later update:

```sh
sudo sh /opt/playoff-picks/deployment/update.sh
```

The updater downloads GitHub `main`, runs the tests and production preflight,
backs up private data and application files, installs the release, refreshes
fantasy scores under the service account, and restarts and health-checks the
site. It preserves `/var/lib/playoff-picks`, `/etc/playoff-picks.env`, and the
Cloudflare configuration. It reports the installed commit and backup path;
the commit is also recorded in `/opt/playoff-picks/deployment/release.txt`.
Updates are serialized, and a failed score refresh preserves the previous
verified cache and returns an error after restarting the service.

To install the updater for the first time, or download its latest version
before updating, use:

```sh
task_update_dir=$(mktemp -d)
git clone --branch main --single-branch https://github.com/aleksibm/playoff-picks.git "$task_update_dir"
sudo sh "$task_update_dir/deployment/update.sh"
```

An optional full commit SHA pins an update to the reviewed version of `main`:
`sudo sh /opt/playoff-picks/deployment/update.sh COMMIT_SHA`.

### Weekly automatic GitHub updates

Enable a server timer that checks GitHub `main` every **Monday at 13:00
Europe/Helsinki**, including daylight saving changes:

```sh
sudo sh /opt/playoff-picks/deployment/enable-weekly-updates.sh
```

For an installation that does not yet contain that script, clone the latest
release first and run its installer:

```sh
task_update_dir=$(mktemp -d)
git clone --branch main --single-branch https://github.com/aleksibm/playoff-picks.git "$task_update_dir"
sudo sh "$task_update_dir/deployment/enable-weekly-updates.sh"
```

The installer verifies an unattended GitHub check as root before enabling the
timer. GitHub CLI browser authentication, when needed, must therefore be set up
for root with `sudo gh auth login --hostname github.com --git-protocol https --web`
and `sudo gh auth setup-git --hostname github.com`.

An unchanged commit causes no backup, application restart, or score refresh. A
new commit goes through the normal tests, preflight, backup, install, refresh,
and health check. Failed downloads or tests leave the running app untouched.
If the server is off at the scheduled time, the persistent timer checks when it
next starts. The timer uses the server's own systemd service.

Inspect or run the check manually with:

```sh
systemctl list-timers playoff-picks-update.timer --no-pager
sudo journalctl -u playoff-picks-update.service -n 50 --no-pager
sudo systemctl start playoff-picks-update.service
```

Disable future scheduled checks with
`sudo systemctl disable --now playoff-picks-update.timer`.
Later app updates preserve timer enablement and administrator drop-in overrides.

### Manual update procedure

The manual procedure below remains available for older installations.

For the systemd installation above, run the following on the hosting laptop. Git
and Node.js 24 must already be installed, and your normal user must have read
access to the GitHub repository. The commands download the current `main` branch
into a fresh temporary folder and test it before stopping the installed service.
They preserve `/var/lib/playoff-picks`, `/etc/playoff-picks.env`, and the live
Cloudflare configuration. No Git checkout is needed inside `/opt/playoff-picks`.

```sh
(
set -eu

task_update_dir=$(mktemp -d)
git clone --branch main --single-branch https://github.com/aleksibm/playoff-picks.git "$task_update_dir"
cd "$task_update_dir"

/usr/bin/node --test tests/*.test.mjs
sudo /usr/bin/node --env-file=/etc/playoff-picks.env deployment/check.mjs --production

sudo sh /opt/playoff-picks/deployment/backup.sh
task_code_backup="/opt/playoff-picks-backup-$(date +%Y%m%d-%H%M%S)"
sudo cp -a /opt/playoff-picks "$task_code_backup"

sudo systemctl stop playoff-picks
trap 'sudo systemctl start playoff-picks' EXIT
sudo cp -R dist deployment tests /opt/playoff-picks/
sudo cp ./*.mjs fantasy-players.json fantasy-roster.json player-contracts.json package.json README.md HOSTING.md SECURITY-REVIEW.md /opt/playoff-picks/
sudo chown -R root:root /opt/playoff-picks
sudo find /opt/playoff-picks -type d -exec chmod 0755 {} +
sudo find /opt/playoff-picks -type f -exec chmod 0644 {} +
sudo systemctl start playoff-picks
trap - EXIT

systemctl is-active playoff-picks
task_public_origin=$(sudo /usr/bin/node --env-file=/etc/playoff-picks.env -p 'process.env.PLAYOFF_PICK_PUBLIC_ORIGIN')
curl --fail --show-error --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 30 "$task_public_origin/api/health"
printf '\nPrevious application files: %s\n' "$task_code_backup"
)
```

The backup script briefly stops and restarts the service while backing up private
data; the file update causes another brief interruption. If a command fails, the
subshell stops. Check `sudo journalctl -u playoff-picks -n 50 --no-pager` before
continuing. The data backup is in `/var/backups/playoff-picks`; the previous app
files remain in the timestamped folder under `/opt`.

After a successful update, check `https://picks.aleksi.net/api/health` and reload
the player site with Ctrl+Shift+R. These same commands also work for later
updates, without replacing the laptop's configuration or private data.

## Operating limits

Use this as a small community game on a dedicated host. Do not give untrusted people local accounts or run unrelated services on this laptop; the backend trusts its local tunnel process. App rate limits reset on restart and can temporarily affect people sharing one network address. Cloudflare provides edge protection, while large-scale abuse still needs monitoring and appropriate rules.

Usernames and locked predictions are public on the leaderboard. Drafts, password hashes, and sessions remain private. Email verification and self-service password recovery are not configured. Players should use a unique password and keep it safely. Keep Linux, cloudflared, and Node 24 security patches current, watch disk space and standings status, and retain tested backups.
