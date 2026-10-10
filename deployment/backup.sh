#!/bin/sh
# Run with sudo on the Linux host. This script never deletes previous backups.
set -eu
umask 077

task_service=playoff-picks.service
task_data_dir=/var/lib/playoff-picks
task_backup_dir=/var/backups/playoff-picks
task_restart=0

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this backup with sudo on the hosting laptop.' >&2
    exit 1
fi
if [ "$#" -ne 0 ]; then
    printf '%s\n' 'Usage: backup.sh (backups are stored in /var/backups/playoff-picks)' >&2
    exit 1
fi
if [ ! -d "$task_data_dir" ] || [ -L "$task_data_dir" ]; then
    printf '%s\n' 'The expected data directory is missing or is a symbolic link.' >&2
    exit 1
fi
mkdir -p -m 700 "$task_backup_dir"
task_backup_real=$(CDPATH='' cd -- "$task_backup_dir" && pwd -P)
case "$task_backup_real/" in
    "$task_data_dir/"*)
        printf '%s\n' 'Store backups outside the app data directory.' >&2
        exit 1 ;;
esac
if [ -L "$task_backup_dir" ]; then
    printf '%s\n' 'The backup directory must not be a symbolic link.' >&2
    exit 1
fi
chmod 700 "$task_backup_dir"

task_finish() {
    task_status=$?
    trap - 0 HUP INT TERM
    if [ "$task_restart" -eq 1 ]; then
        if ! systemctl start "$task_service"; then
            printf '%s\n' 'The app did not restart. Check systemctl status playoff-picks immediately.' >&2
            task_status=1
        fi
    fi
    exit "$task_status"
}
trap task_finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if systemctl is-active --quiet "$task_service"; then task_restart=1; fi
systemctl stop "$task_service"
if systemctl is-active --quiet "$task_service"; then
    printf '%s\n' 'The app is still active; backup cancelled.' >&2
    exit 1
fi

# Include SQLite WAL/SHM files if present, and the verified standings cache.
# The stopped service cannot write during this copy. Do not run a second manual server.
task_temporary=$(mktemp "$task_backup_dir/playoff-picks-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
task_partial="$task_temporary.tar.gz.partial"
mv "$task_temporary" "$task_partial"
tar -C "$task_data_dir" -czf "$task_partial" .
task_archive=${task_partial%.partial}
mv "$task_partial" "$task_archive"
(cd "$task_backup_dir" && sha256sum "$(basename "$task_archive")") > "$task_archive.sha256"
printf 'Backup saved: %s\n' "$task_archive"
printf '%s\n' 'Keep this archive private; it contains account hashes and sessions.'
