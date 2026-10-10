#!/bin/sh
set -eu

task_app_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
task_node=${PLAYOFF_PICK_NODE:-node}
cd "$task_app_dir"
"$task_node" deployment/check.mjs
exec "$task_node" server.mjs
