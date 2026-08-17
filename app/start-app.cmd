@echo off
rem ============================================================
rem GSV - Demarrage automatique du serveur de l'application
rem Lance le serveur web (port 8080) s'il n'est pas deja actif
rem ============================================================
netstat -ano | findstr /C:":8080 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
cd /d "C:\Users\hp\Pictures\gestion de stock\app"
start "" /min "C:\Program Files\nodejs\node.exe" serve-app.js
