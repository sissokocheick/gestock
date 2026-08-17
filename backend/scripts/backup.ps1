# ============================================================
# GSV - Sauvegarde quotidienne de la base gestion_stock
# Garde les 14 dernieres sauvegardes (format compresse pg_dump)
# Identifiants lus depuis .env (meme source que le backend)
# ============================================================
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot "..\.env"
$line = Get-Content $envFile | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
if ($line -notmatch '^DATABASE_URL=postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)$') { Write-Error "DATABASE_URL introuvable ou invalide dans $envFile" }
$env:PGUSER = $Matches[1]
$env:PGPASSWORD = $Matches[2]
$env:PGHOST = $Matches[3]
$env:PGPORT = $Matches[4]
$pg = "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
$dir = "C:\Users\hp\Pictures\gestion de stock\backups"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir ("gestion_stock_" + (Get-Date -Format "yyyy-MM-dd_HHmmss") + ".backup")
& $pg -F c -b -f $file gestion_stock
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump a echoue (code $LASTEXITCODE)" }
Write-Host "Sauvegarde creee : $file"
Get-ChildItem $dir -Filter "*.backup" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force
