#!/usr/bin/env bash
# my-assistant — macOS / Linux / WSL installer
# Copies skills to ~/.claude/skills/ and commands to ~/.claude/commands/ so Claude Code
# can discover them. This repo is the single source of truth - .claude/skills and
# .claude/commands are installed artifacts only, never hand-edited.

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE="$REPO_ROOT/skills"
COMMANDS_SOURCE="$REPO_ROOT/commands"
SKILLS_DEST="$HOME/.claude/skills"
COMMANDS_DEST="$HOME/.claude/commands"

names=(my-assistant my-assistant-task my-assistant-save my-assistant-update)

mkdir -p "$COMMANDS_DEST"

for name in "${names[@]}"; do
  dest="$SKILLS_DEST/$name"
  mkdir -p "$dest"
  cp "$SKILLS_SOURCE/$name/SKILL.md" "$dest/SKILL.md"
  cp "$COMMANDS_SOURCE/$name.md" "$COMMANDS_DEST/$name.md"
  echo "Installed: $name (skill + command)"
done

echo ""
echo "Done. Restart Claude Code, then run /my-assistant-update to build your base knowledge."
