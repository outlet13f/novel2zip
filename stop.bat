@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "SERVER_JS=%~dp0server.js"

echo Novel Downloader 서버를 종료합니다...
rem 진행 중인 다운로드(download_full.js)와 Chrome까지 프로세스 트리 전체를 종료
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($env:SERVER_JS.ToLower()) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F *> $null }"
echo 서버가 완전히 종료되었습니다.
