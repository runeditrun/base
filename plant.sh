#!/usr/bin/env bash
# Plants the governing documents and the bootstrap prompt into seed repos.
#
#   ./plant.sh                    plant every sibling directory of this repo
#   ./plant.sh ../lily ...        plant only the named repos
#   ./plant.sh --force [...]      overwrite files that already exist
#
# Without --force, existing files are skipped: the planted docs are starters,
# and a repo that has diverged its copy keeps its divergence. Note a repo that
# finished bootstrapping deletes BOOTSTRAP.md and CONTRACT.example.md, so
# re-running plant.sh on it puts them back — don't re-plant finished repos.
set -euo pipefail

base_dir="$(cd "$(dirname "$0")" && pwd)"
files=(
  export/AGENTS.md
  export/AGENTS.consumer.md
  export/BASELINE.md
  export/CLAUDE.md
  export/CONTRACT.example.md
  BOOTSTRAP.md
)

force=0
if [ "${1:-}" = "--force" ]; then
  force=1
  shift
fi

if [ "$#" -gt 0 ]; then
  targets=("$@")
else
  targets=()
  for d in "$base_dir"/../*/; do
    [ "$(cd "$d" && pwd)" = "$base_dir" ] && continue
    targets+=("$d")
  done
fi

for repo in "${targets[@]}"; do
  repo="$(cd "$repo" && pwd)"
  name="$(basename "$repo")"
  for f in "${files[@]}"; do
    dest="$repo/$(basename "$f")"
    if [ -e "$dest" ] && [ "$force" -eq 0 ]; then
      echo "$name: skip $(basename "$f") (exists)"
    else
      cp "$base_dir/$f" "$dest"
      echo "$name: planted $(basename "$f")"
    fi
  done
done
