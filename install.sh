#!/usr/bin/env bash
# my-assistant — macOS / Linux / WSL installer
# Copies skills to ~/.claude/skills/ so Claude Code can discover them

set -e

SKILLS_SOURCE="$(cd "$(dirname "$0")/skills" && pwd)"
SKILLS_DEST="$HOME/.claude/skills"

skills=(my-assistant my-assistant-task my-assistant-save my-assistant-update)

for skill in "${skills[@]}"; do
  dest="$SKILLS_DEST/$skill"
  mkdir -p "$dest"
  cp "$SKILLS_SOURCE/$skill/SKILL.md" "$dest/SKILL.md"
  echo "Installed: $skill"
done

echo ""
echo "Done. Restart Claude Code, then run /my-assistant-update to build your base knowledge."
