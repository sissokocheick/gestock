@echo off
rem ============================================================
rem GSV - Demarrage automatique du backend (tache planifiee)
rem Lance le serveur si le port 4000 n'est pas deja occupe
rem ============================================================
netstat -ano | findstr /C:":4000 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
cd /d "C:\Users\hp\Pictures\gestion de stock\backend"
start "" /min "C:\Program Files\nodejs\node.exe" src\server.js
