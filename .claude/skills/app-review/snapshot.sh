#!/usr/bin/env bash
# Saves and restores this worktree's app-data for the app-review skill. Stop the app first.
#
#   snapshot.sh clear    delete the app's state
#   snapshot.sh save     copy the app's state to app-data/snapshot/files
#   snapshot.sh restore  clear, then copy the snapshot back
set -euo pipefail
shopt -s dotglob nullglob

# The one list of what is not state: never saved, never cleared, never restored. Anything else in
# app-data is state, so a folder the app adds later is part of the snapshot without a change here.
is_excluded() {
  case "$1" in
    logs | screenshots | temp | snapshot | appctrl*) return 0 ;;
    *) return 1 ;;
  esac
}

clear_state() {
  for entry in *; do
    is_excluded "$entry" || rm -rf -- "$entry"
  done
}

root="$(git rev-parse --show-toplevel)/app-data"
mkdir -p "$root"
cd "$root"

case "${1:-}" in
  clear)
    clear_state
    ;;
  save)
    rm -rf snapshot/files
    mkdir -p snapshot/files
    for entry in *; do
      is_excluded "$entry" || cp -a -- "$entry" snapshot/files/
    done
    ;;
  restore)
    if [ ! -d snapshot/files ]; then
      echo "No snapshot in $root/snapshot/files" >&2
      exit 1
    fi
    clear_state
    cp -a snapshot/files/. .
    ;;
  *)
    echo "Usage: snapshot.sh clear|save|restore" >&2
    exit 2
    ;;
esac
