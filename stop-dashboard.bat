@echo off
taskkill /F /T /FI "WINDOWTITLE eq FLICO Dashboard Server*"
echo Dashboard stopped.
pause