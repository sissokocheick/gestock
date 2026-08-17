# Enregistre la tache GSV-Sauvegarde : quotidienne a 02h00
#
# IMPORTANT (compte local) : le mode S4U (sans mot de passe, fonctionne hors session)
# n'existe que pour les comptes de domaine (Kerberos). Sur un compte local, Windows
# retombe silencieusement en InteractiveToken : la tache ne tourne alors QUE si
# l'utilisateur est connecte a 02h00 (sinon elle se rattrape au prochain logon,
# grace a StartWhenAvailable).
#
# Pour une sauvegarde VRAIMENT autonome (PC allume, personne connectee), fournir le
# mot de passe Windows :  .\register-backup-task.ps1 -Password "VotreMotDePasse"
# (stocke par le Planificateur de taches, crypte pour ce compte).
param([string]$Password = "")

$ErrorActionPreference = "Stop"
$taskName = "GSV-Sauvegarde"
$scriptPath = "C:\Users\hp\Pictures\gestion de stock\backend\scripts\backup.ps1"
$userId = "$env:USERDOMAIN\$env:USERNAME"

if ($Password) {
  $logonXml = "Password"
  $regFlags = 2   # TASK_CREATE
  $logonFlag = 1  # TASK_LOGON_PASSWORD
} else {
  $logonXml = "InteractiveToken"
  $regFlags = 6   # TASK_CREATE_OR_UPDATE
  $logonFlag = 0  # TASK_LOGON_INTERACTIVE_TOKEN
}

$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$folder = $svc.GetFolder("\")
try { $folder.DeleteTask($taskName, 0) } catch { }

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sauvegarde quotidienne de la base gestion_stock (02h00)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-08-15T02:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>$logonXml</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$scriptPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

if ($Password) {
  $folder.RegisterTask($taskName, $xml, $regFlags, $userId, $Password, $logonFlag, $null) | Out-Null
} else {
  $folder.RegisterTask($taskName, $xml, $regFlags, $null, $null, $logonFlag, $null) | Out-Null
}

if ($Password) {
  Write-Host "Tache '$taskName' enregistree (Mode : Mot de passe) - tourne meme sans session ouverte a 02h00."
} else {
  Write-Host "Tache '$taskName' enregistree (Mode : Interactif - ne tourne que si vous etes connecte a 02h00)."
  Write-Host "Astuce : relancez avec  -Password \"...\"  pour un mode totalement autonome."
}
