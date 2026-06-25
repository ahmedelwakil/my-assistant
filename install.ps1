# my-assistant — Windows installer
# Copies skills to ~/.claude/skills/ so Claude Code can discover them

$skillsSource = Join-Path $PSScriptRoot "skills"
$skillsDest   = Join-Path $HOME ".claude\skills"

$skills = @("my-assistant", "my-assistant-task", "my-assistant-save", "my-assistant-update")

foreach ($skill in $skills) {
    $src  = Join-Path $skillsSource $skill
    $dest = Join-Path $skillsDest  $skill
    New-Item -ItemType Directory -Force $dest | Out-Null
    Copy-Item -Path (Join-Path $src "SKILL.md") -Destination (Join-Path $dest "SKILL.md") -Force
    Write-Host "Installed: $skill"
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then run /my-assistant-update to build your base knowledge."
