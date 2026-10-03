@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Novel Downloader 서버 재시작을 진행합니다...
call "%~dp0stop.bat"
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
call "%~dp0start.bat"
