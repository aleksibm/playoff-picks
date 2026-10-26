#!/bin/sh
# Install the current GitHub release and enable its server-side update timer.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this installer with sudo on the hosting laptop.' >&2
    exit 1
fi
if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: enable-weekly-updates.sh [expected-main-commit]' >&2
    exit 1
fi
task_directory=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
if [ "$#" -eq 1 ]; then
    sh "$task_directory/update.sh" "$1"
else
    sh "$task_directory/update.sh" --if-new
fi

systemd-analyze verify /opt/playoff-picks/deployment/playoff-picks-update.service /opt/playoff-picks/deployment/playoff-picks-update.timer
install -m 0644 /opt/playoff-picks/deployment/playoff-picks-update.service /opt/playoff-picks/deployment/playoff-picks-update.timer /etc/systemd/system/
systemctl daemon-reload
# Verify the noninteractive root GitHub login before enabling a recurring job.
systemctl start playoff-picks-update.service
systemctl enable --now playoff-picks-update.timer
systemctl list-timers playoff-picks-update.timer --no-pager
printf '%s\n' 'Weekly GitHub checks and automatic updates are enabled.'
