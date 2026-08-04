# my-assistant — Windows installer
# Copies skills to ~/.claude/skills/ and commands to ~/.claude/commands/ so Claude Code
# can discover them. This repo is the single source of truth - .claude/skills and
# .claude/commands are installed artifacts only, never hand-edited.

$skillsSource   = Join-Path $PSScriptRoot "skills"
$commandsSource = Join-Path $PSScriptRoot "commands"
$skillsDest     = Join-Path $HOME ".claude\skills"
$commandsDest   = Join-Path $HOME ".claude\commands"

$names = @("my-assistant", "my-assistant-task", "my-assistant-save", "my-assistant-update")

New-Item -ItemType Directory -Force $commandsDest | Out-Null

foreach ($name in $names) {
    $src  = Join-Path $skillsSource $name
    $dest = Join-Path $skillsDest  $name
    New-Item -ItemType Directory -Force $dest | Out-Null
    Copy-Item -Path (Join-Path $src "SKILL.md") -Destination (Join-Path $dest "SKILL.md") -Force
    Copy-Item -Path (Join-Path $commandsSource "$name.md") -Destination (Join-Path $commandsDest "$name.md") -Force
    Write-Host "Installed: $name (skill + command)"
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then run /my-assistant-update to build your base knowledge."
