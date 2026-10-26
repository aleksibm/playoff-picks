#!/bin/sh
# Run on the Linux host with sudo. Optional argument: the exact main commit.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this updater with sudo on the hosting laptop.' >&2
    exit 1
fi
if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: update.sh [expected-main-commit]' >&2
    exit 1
fi
task_expected=${1-}
if [ -n "$task_expected" ]; then
    case "$task_expected" in *[!0-9a-f]* ) exit 1 ;; esac
    if [ "${#task_expected}" -ne 40 ]; then exit 1; fi
fi
if [ ! -d /opt/playoff-picks ] || [ -L /opt/playoff-picks ]; then
    printf '%s\n' 'The expected application directory is missing or is a symbolic link.' >&2
    exit 1
fi

# Keep the executing script outside the directory it is about to overwrite.
if [ "$(readlink -f "$0")" = /opt/playoff-picks/deployment/update.sh ]; then
    task_script_copy=$(mktemp /tmp/playoff-picks-updater-XXXXXX)
    cp "$0" "$task_script_copy"
    exec sh "$task_script_copy" "$@"
fi

# Serialize updates, including the stopped-service refresh and its cache writes.
exec 9>/run/lock/playoff-picks-update.lock
if ! flock -n 9; then
    printf '%s\n' 'Another Playoff Pick update is already running.' >&2
    exit 1
fi
task_update_dir=$(mktemp -d /tmp/playoff-picks-update-XXXXXX)
git clone --branch main --single-branch https://github.com/aleksibm/playoff-picks.git "$task_update_dir"
cd "$task_update_dir"
task_commit=$(git rev-parse HEAD)
if [ -n "$task_expected" ] && [ "$task_expected" != "$task_commit" ]; then
    printf '%s\n' 'GitHub main changed. Review its new commit before deploying.' >&2
    exit 1
fi

# A failed test or preflight leaves the running installation untouched.
/usr/bin/node --test tests/*.test.mjs
/usr/bin/node --env-file=/etc/playoff-picks.env deployment/check.mjs --production
sh /opt/playoff-picks/deployment/backup.sh
task_code_backup=$(mktemp -d /opt/playoff-picks-backup-XXXXXX)
cp -a /opt/playoff-picks/. "$task_code_backup/"
printf 'Previous application files: %s\n' "$task_code_backup"

task_restart=1
task_finish() {
    task_status=$?
    trap - 0 HUP INT TERM
    if [ "$task_restart" -eq 1 ]; then
        if ! systemctl start playoff-picks; then
            printf '%s\n' 'The app did not restart. Check systemctl status playoff-picks.' >&2
            task_status=1
        fi
    fi
    exit "$task_status"
}
trap task_finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl stop playoff-picks
cp -R dist deployment tests /opt/playoff-picks/
cp ./*.mjs fantasy-players.json fantasy-roster.json player-contracts.json package.json README.md HOSTING.md SECURITY-REVIEW.md /opt/playoff-picks/
chown -R root:root /opt/playoff-picks
find /opt/playoff-picks -type d -exec chmod 0755 {} +
find /opt/playoff-picks -type f -exec chmod 0644 {} +
printf '%s\n' "$task_commit" > /opt/playoff-picks/deployment/release.txt
chmod 0644 /opt/playoff-picks/deployment/release.txt

# Rebuild details and catch up scores under the service identity. The score
# ledger is replaced atomically only after the entire feed is verified.
task_refresh_failed=0
if ! timeout 300 /usr/bin/node --env-file=/etc/playoff-picks.env --input-type=module <<'NODE'
import { createApp } from '/opt/playoff-picks/server.mjs';
process.chdir('/opt/playoff-picks');
process.umask(0o077);
process.initgroups('playoff-pick', 'playoff-pick');
process.setgid('playoff-pick');
process.setuid('playoff-pick');
const app = createApp({
  allowStandingsFetch: false, allowRosterFetch: false,
  allowContractFetch: false, allowFantasyFetch: true
});
try {
  const result = await app.refreshFantasy();
  console.log(JSON.stringify(result));
  if (result.error || !result.available || result.stale) process.exitCode = 1;
} finally {
  await app.close();
}
NODE
then
    task_refresh_failed=1
    printf '%s\n' 'Score refresh failed; the previous verified cache remains. The service will retry.' >&2
fi
systemctl start playoff-picks
task_restart=0
systemctl is-active playoff-picks
task_public_origin=$(/usr/bin/node --env-file=/etc/playoff-picks.env -p 'process.env.PLAYOFF_PICK_PUBLIC_ORIGIN')
curl --fail --show-error --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 30 "$task_public_origin/api/health"
printf '\nInstalled GitHub commit: %s\n' "$task_commit"
if [ "$task_refresh_failed" -ne 0 ]; then exit 1; fi
