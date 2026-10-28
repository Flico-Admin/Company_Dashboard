@echo off
cd /d "%~dp0"
node server.js >> dashboard-log.txt 2>&1
