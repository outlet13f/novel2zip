@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "SERVER_JS=%~dp0server.js"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 설치해 주세요.
    exit /b 1
)
if not exist node_modules (
    echo 의존성 패키지가 없습니다. 먼저 "npm install" 을 실행해 주세요.
    exit /b 1
)

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($env:SERVER_JS.ToLower()) }) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
    echo Novel Downloader 서버가 이미 실행 중입니다.
    exit /b 0
)

echo Novel Downloader 서버를 시작합니다...
powershell -NoProfile -Command "Start-Process cmd -ArgumentList ('/c node ' + [char]34 + $env:SERVER_JS + [char]34 + ' > server.log 2>&1') -WindowStyle Hidden"
echo 서버가 시작되었습니다. http://localhost:3000 (로그: server.log)
