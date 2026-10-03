const path = require('path');
const { execFileSync } = require('child_process');

// 스크래퍼용 Chrome 프로필을 고정 경로에 둠 → 서버를 재시작해도 캡차 통과 기록(쿠키)이 유지됨
const BROWSER_DATA_DIR = path.join(__dirname, 'browser-data');
const PROFILE_DIR = path.join(BROWSER_DATA_DIR, 'profile');

// 이 프로필을 쓰는 Chrome 강제 종료 (강제 종료된 이전 실행이 남긴 Chrome 정리용)
const killProfileBrowsers = () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($env:NOVEL2ZIP_PROFILE_DIR.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
        { env: { ...process.env, NOVEL2ZIP_PROFILE_DIR: PROFILE_DIR }, stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', PROFILE_DIR]);
    }
  } catch (e) {}
};

module.exports = { BROWSER_DATA_DIR, PROFILE_DIR, killProfileBrowsers };
