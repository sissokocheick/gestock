# Enregistre GSV-Backend et GSV-App : démarrage automatique au logon
# (chemin avec espaces correctement cité — corrige l'ancienne coupure "gestion de stock")
$ErrorActionPreference = "Stop"

function Register-StartTask {
  param(
    [string]$TaskName,
    [string]$ScriptCmd,
    [string]$Description
  )
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ('/c ""' + $ScriptCmd + '""')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description $Description -Force | Out-Null
  Write-Host "Tache '$TaskName' enregistree : $ScriptCmd"
}

$backend = "C:\Users\hp\Pictures\gestion de stock\backend\scripts\start-backend.cmd"
$app = "C:\Users\hp\Pictures\gestion de stock\app\start-app.cmd"

Register-StartTask -TaskName "GSV-Backend" -ScriptCmd $backend -Description "Demarre le backend GSV (port 4000) au logon"
Register-StartTask -TaskName "GSV-App" -ScriptCmd $app -Description "Demarre le serveur web GSV (port 8080) au logon"

Write-Host "Termine."
