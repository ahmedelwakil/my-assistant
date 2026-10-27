# my-assistant - Windows installer
# Copies skills to ~/.claude/skills/ and commands to ~/.claude/commands/ so Claude Code
# can discover them. This repo is the single source of truth - .claude/skills and
# .claude/commands are installed artifacts only, never hand-edited.
# If an installed file already exists and differs, it is backed up next to it first
# (SKILL.md.bak-<timestamp>) so local edits are never lost silently.
# The optional compaction hook (hooks/) and the workflow scripts (workflows/) are NOT installed here.

$ErrorActionPreference = 'Stop'

$root           = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$skillsSource   = Join-Path $root "skills"
$commandsSource = Join-Path $root "commands"
$skillsDest     = Join-Path $HOME ".claude\skills"
$commandsDest   = Join-Path $HOME ".claude\commands"
$configDest     = Join-Path $HOME ".claude\my-assistant"
$stamp          = Get-Date -Format "yyyyMMddHHmmss"

$names = @("my-assistant", "my-assistant-task", "my-assistant-save", "my-assistant-update")

New-Item -ItemType Directory -Force $commandsDest | Out-Null

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
    Install-File (Join-Path $commandsSource "$name.md") (Join-Path $commandsDest "$name.md")
    Write-Host "Installed: $name (skill + command)"
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then run /my-assistant to start, and /my-assistant-save to record knowledge. (/my-assistant-update is deprecated.)"
Write-Host "Optional: see hooks/README.md to restore your pinned rules after a context compaction."
