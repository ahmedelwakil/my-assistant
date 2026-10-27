# my-assistant - Windows installer
# Copies the skills to ~/.claude/skills/ so Claude Code can discover them (each skill is also
# invokable as a slash command, so no separate command files are installed). This repo is the
# single source of truth - the installed copies are artifacts only, never hand-edited.
# If an installed file already exists and differs, it is backed up next to it first
# (SKILL.md.bak-<timestamp>) so local edits are never lost silently.
# The optional compaction hook (hooks/) and the workflow scripts (workflows/) are NOT installed here.

$ErrorActionPreference = 'Stop'

$root         = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$skillsSource = Join-Path $root "skills"
$skillsDest   = Join-Path $HOME ".claude\skills"
$commandsOld  = Join-Path $HOME ".claude\commands"
$configDest   = Join-Path $HOME ".claude\my-assistant"
$stamp        = Get-Date -Format "yyyyMMddHHmmss"

$names = @("my-assistant", "my-assistant-task", "my-assistant-save", "my-assistant-update")

# Empty on purpose - no config-location pointer, no values. The first skill you actually
# run asks one question and writes that pointer itself; this just makes sure the directory
# it writes into already exists and is writable.
New-Item -ItemType Directory -Force $configDest | Out-Null

function Install-File($from, $to) {
    if (-not (Test-Path $from)) { throw "Missing source file: $from" }
    if ((Test-Path $to) -and ((Get-FileHash $from).Hash -ne (Get-FileHash $to).Hash)) {
        Copy-Item -Path $to -Destination "$to.bak-$stamp"
        Write-Host "  backed up existing $(Split-Path -Leaf $to) as $(Split-Path -Leaf $to).bak-$stamp"
    }
    Copy-Item -Path $from -Destination $to -Force
}

foreach ($name in $names) {
    $dest = Join-Path $skillsDest $name
    New-Item -ItemType Directory -Force $dest | Out-Null
    Install-File (Join-Path (Join-Path $skillsSource $name) "SKILL.md") (Join-Path $dest "SKILL.md")
    Write-Host "Installed: $name"
}

# Earlier versions also copied each skill into ~/.claude/commands/, which makes autocomplete list every
# name twice. Tell the user instead of deleting anything.
$stale = @($names | ForEach-Object { Join-Path $commandsOld "$_.md" } | Where-Object { Test-Path $_ })
if ($stale.Count -gt 0) {
    Write-Host ""
    Write-Host "Note: these old command copies from an earlier install cause duplicate autocomplete entries; you can delete them:"
    $stale | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then run /my-assistant to start, and /my-assistant-save to record knowledge. (/my-assistant-update is deprecated.)"
Write-Host "Optional: see hooks/README.md to restore your pinned rules after a context compaction."
