/* GSV - Crée le rôle BDD dédié gsv_app (mot de passe fort généré ici, jamais affiché),
   met à jour .env (workspace + Pictures) et réécrit backup.ps1 pour lire .env. */
const { Client } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BACKEND = path.join(__dirname, "..");
const PICTURES_BACKEND = "C:\\Users\\hp\\Pictures\\gestion de stock\\backend";
const ENV_FILES = [path.join(BACKEND, ".env"), path.join(PICTURES_BACKEND, ".env")];
const BACKUP_SCRIPT = path.join(PICTURES_BACKEND, "scripts", "backup.ps1");

async function main() {
  const oldEnv = fs.readFileSync(ENV_FILES[0], "utf8");
  const m = oldEnv.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL introuvable dans .env");
  const oldUrl = m[1].trim();

  const client = new Client({ connectionString: oldUrl });
  await client.connect();

  const pw = crypto.randomBytes(18).toString("base64url");
  const url = new URL(oldUrl);
  url.username = "gsv_app";
  url.password = pw;

  const esc = pw.replace(/'/g, "''");
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gsv_app') THEN
      CREATE ROLE gsv_app LOGIN PASSWORD '${esc}';
    ELSE
      ALTER ROLE gsv_app LOGIN PASSWORD '${esc}';
    END IF; END $$;`);
  await client.query("GRANT CONNECT ON DATABASE gestion_stock TO gsv_app");
  await client.query("GRANT USAGE ON SCHEMA public TO gsv_app");
  await client.query("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO gsv_app");
  await client.query("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO gsv_app");
  await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO gsv_app");
  await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO gsv_app");
  /* L'audit doit rester inaltérable : INSERT/SELECT seulement (le role propriétaire postgres garde la main) */
  await client.query("REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM gsv_app");
  await client.end();

  const newUrl = url.toString();
  for (const f of ENV_FILES) {
    let s = fs.readFileSync(f, "utf8");
    if (!/^DATABASE_URL=/m.test(s)) throw new Error("DATABASE_URL absente de " + f);
    s = s.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=" + newUrl);
    fs.writeFileSync(f, s);
  }

  fs.writeFileSync(BACKUP_SCRIPT, `# ============================================================
# GSV - Sauvegarde quotidienne de la base gestion_stock
# Garde les 14 dernieres sauvegardes (format compresse pg_dump)
# Identifiants lus depuis .env (meme source que le backend)
# ============================================================
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot "..\\.env"
$line = Get-Content $envFile | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
if ($line -notmatch '^DATABASE_URL=postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\\d+)/(.+)$') { Write-Error "DATABASE_URL introuvable ou invalide dans $envFile" }
$env:PGUSER = $Matches[1]
$env:PGPASSWORD = $Matches[2]
$env:PGHOST = $Matches[3]
$env:PGPORT = $Matches[4]
$pg = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"
$dir = "C:\\Users\\hp\\Pictures\\gestion de stock\\backups"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir ("gestion_stock_" + (Get-Date -Format "yyyy-MM-dd_HHmmss") + ".backup")
& $pg -F c -b -f $file gestion_stock
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump a echoue (code $LASTEXITCODE)" }
Write-Host "Sauvegarde creee : $file"
Get-ChildItem $dir -Filter "*.backup" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Force
`);

  console.log("ROLE_OK role=gsv_app hote=" + url.host + " base=" + url.pathname.slice(1) +
    " env_mis_a_jour=" + ENV_FILES.length + " backup_ps1_reecrit=ok (mot de passe jamais affiche)");
}

main().catch(e => { console.error("ECHEC:", e.message); process.exit(1); });
