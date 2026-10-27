#!/usr/bin/env bash
# my-assistant - macOS / Linux / WSL installer
# Copies skills to ~/.claude/skills/ and commands to ~/.claude/commands/ so Claude Code
# can discover them. This repo is the single source of truth - .claude/skills and
# .claude/commands are installed artifacts only, never hand-edited.
# If an installed file already exists and differs, it is backed up next to it first
# (SKILL.md.bak-<timestamp>) so local edits are never lost silently.
# The optional compaction hook (hooks/) and the workflow scripts (workflows/) are NOT installed here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE="$REPO_ROOT/skills"
COMMANDS_SOURCE="$REPO_ROOT/commands"
SKILLS_DEST="$HOME/.claude/skills"
COMMANDS_DEST="$HOME/.claude/commands"
CONFIG_DEST="$HOME/.claude/my-assistant"
STAMP="$(date +%Y%m%d%H%M%S)"

names=(my-assistant my-assistant-task my-assistant-save my-assistant-update)

mkdir -p "$COMMANDS_DEST"

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
  install_file "$COMMANDS_SOURCE/$name.md" "$COMMANDS_DEST/$name.md"
  echo "Installed: $name (skill + command)"
done

echo ""
echo "Done. Restart Claude Code, then run /my-assistant to start, and /my-assistant-save to record knowledge. (/my-assistant-update is deprecated.)"
echo "Optional: see hooks/README.md to restore your pinned rules after a context compaction."
