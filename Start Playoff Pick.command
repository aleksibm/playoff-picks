#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
playoff_node_bin="$(command -v node)"
if [[ -z "$playoff_node_bin" ]]; then
  playoff_node_bin="/Users/aleksi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$playoff_node_bin" ]]; then
  print "This app needs Node.js 24 or later. Install Node.js, then open this launcher again."
  read -k 1
  exit 1
fi
print "Opening the local app. Visit http://127.0.0.1:8765/ in your browser."
print "Administration on this computer only: http://127.0.0.1:8766/"
print "Keep this window open while using the site. Press Control-C to stop."
exec "$playoff_node_bin" server.mjs
