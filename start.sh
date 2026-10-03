#!/bin/bash
if pgrep -f "node server.js" > /dev/null; then
    echo "Novel Downloader 서버가 이미 실행 중입니다."
else
    echo "Novel Downloader 서버를 시작합니다..."
    nohup node server.js > server.log 2>&1 &
    echo "서버가 시작되었습니다. (로그: server.log)"
fi
