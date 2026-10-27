#!/usr/bin/env bash
# my-assistant - macOS / Linux / WSL installer
# Copies the skills to ~/.claude/skills/ so Claude Code can discover them (each skill is also
# invokable as a slash command, so no separate command files are installed). This repo is the
# single source of truth - the installed copies are artifacts only, never hand-edited.
# If an installed file already exists and differs, it is backed up next to it first
# (SKILL.md.bak-<timestamp>) so local edits are never lost silently.
# The optional compaction hook (hooks/) and the workflow scripts (workflows/) are NOT installed here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE="$REPO_ROOT/skills"
SKILLS_DEST="$HOME/.claude/skills"
COMMANDS_OLD="$HOME/.claude/commands"
CONFIG_DEST="$HOME/.claude/my-assistant"
STAMP="$(date +%Y%m%d%H%M%S)"

names=(my-assistant my-assistant-task my-assistant-save my-assistant-update)

# Empty on purpose - no config-location pointer, no values. The first skill you actually
# run asks one question and writes that pointer itself; this just makes sure the directory
# it writes into already exists and is writable.
mkdir -p "$CONFIG_DEST"

install_file() {
  local from="$1" to="$2"
  [ -f "$from" ] || { echo "Missing source file: $from" >&2; exit 1; }
  if [ -f "$to" ] && ! cmp -s "$from" "$to"; then
    cp "$to" "$to.bak-$STAMP"
    echo "  backed up existing $(basename "$to") as $(basename "$to").bak-$STAMP"
  fi
  cp "$from" "$to"
}

for name in "${names[@]}"; do
  dest="$SKILLS_DEST/$name"
  mkdir -p "$dest"
  install_file "$SKILLS_SOURCE/$name/SKILL.md" "$dest/SKILL.md"
  echo "Installed: $name"
done

# Earlier versions also copied each skill into ~/.claude/commands/, which makes autocomplete list every
# name twice. Tell the user instead of deleting anything.
stale=()
for name in "${names[@]}"; do
  [ -f "$COMMANDS_OLD/$name.md" ] && stale+=("$COMMANDS_OLD/$name.md")
done
if [ "${#stale[@]}" -gt 0 ]; then
  echo ""
  echo "Note: these old command copies from an earlier install cause duplicate autocomplete entries; you can delete them:"
  printf '  %s\n' "${stale[@]}"
fi

echo ""
echo "Done. Restart Claude Code, then run /my-assistant to start, and /my-assistant-save to record knowledge. (/my-assistant-update is deprecated.)"
echo "Optional: see hooks/README.md to restore your pinned rules after a context compaction."
