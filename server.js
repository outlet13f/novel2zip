const express = require('express');
const cors = require('cors');
const { spawn, fork } = require('child_process');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentProcess = null;
let currentUrl = null;
let logs = [];
let clients = [];

const broadcastLog = (msg) => {
  const logEntry = { time: new Date().toISOString(), message: msg };
  logs.push(logEntry);
  if (logs.length > 500) logs.shift(); // Keep last 500 logs
  
  clients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
};

const fs = require('fs');
const queuePath = path.join(__dirname, 'queue.json');

// 대기열: [{ id, url, chunkSize }] — 앱을 다시 켜도 유지되도록 파일에 저장
let queue = [];
try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch(e) {}
let stoppedByUser = false;

// 로그 기록에 남기지 않는 이벤트 (대기열 변경 알림)
const broadcastEvent = (msg) => {
  const entry = { time: new Date().toISOString(), message: msg };
  clients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
};

const saveQueue = () => {
  try { fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2)); } catch(e) {}
  broadcastEvent(`@@QUEUE@@${JSON.stringify(queue)}`);
};

const parseChunkSize = (v) => Number.isInteger(v) && v >= 0 ? v : 500;

const loadSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
  } catch(e) {
    return { downloadPath: '', ebookPath: '' };
  }
};

// 작업 시작. 실패 시 에러 메시지 반환
const startJob = (url, chunkSize) => {
  if (currentProcess) return 'Process is already running';

  const settings = loadSettings();
  if (!settings.downloadPath || !settings.ebookPath) {
    return '다운로드 폴더와 EBOOK 저장 폴더를 먼저 설정해주세요.';
  }

  // Save history
  const historyPath = path.join(__dirname, 'history.json');
  let history = [];
  try {
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
  } catch(e) {}
  
  // Normalize history to objects
  history = history.map(item => typeof item === 'string' ? { url: item, title: item } : item);
  
  const existingIndex = history.findIndex(h => h.url === url);
  if (existingIndex >= 0) {
    const [existing] = history.splice(existingIndex, 1);
    history.unshift(existing);
  } else {
    history.unshift({ url, title: url });
  }
  
  if (history.length > 50) history.pop();
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  stoppedByUser = false;
  logs = [];
  broadcastLog('__CLEAR__');
  broadcastLog(`Starting scraper for URL: ${url} (EBOOK 분할: ${chunkSize > 0 ? chunkSize + '화' : '분할 안 함'})`);
  
  currentUrl = url;
  currentProcess = fork(path.join(__dirname, 'download_full.js'), [], {
    env: { ...process.env, TARGET_URL: url, DOWNLOAD_PATH: settings.downloadPath, EBOOK_PATH: settings.ebookPath, EPUB_CHUNK_SIZE: String(chunkSize) },
    stdio: 'pipe'
  });
  
  currentProcess.stdout.on('data', (data) => {
    const out = data.toString();
    const lines = out.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('@@META@@')) {
        try {
          const meta = JSON.parse(trimmed.substring(8));
          if (meta.title && meta.url) {
            const hPath = path.join(__dirname, 'history.json');
            if (fs.existsSync(hPath)) {
              let hist = JSON.parse(fs.readFileSync(hPath, 'utf8'));
              hist = hist.map(item => typeof item === 'string' ? { url: item, title: item } : item);
              const idx = hist.findIndex(h => h.url === meta.url);
              if (idx >= 0) {
                hist[idx].title = meta.title;
                fs.writeFileSync(hPath, JSON.stringify(hist, null, 2));
              }
            }
          }
        } catch(e) {}
      }
      broadcastLog(trimmed);
    });
  });
  
  currentProcess.stderr.on('data', (data) => {
    broadcastLog(`ERROR: ${data.toString().trim()}`);
  });
  
  const proc = currentProcess;
  currentProcess.on('close', (code) => {
    broadcastLog(`Process exited with code ${code}`);
    if (currentProcess !== proc) return; // 중지 후 이미 새 작업이 시작된 경우
    currentProcess = null;
    currentUrl = null;
    // 성공/실패와 관계없이 5초 뒤 대기열의 다음 작품 시작 (중지 버튼으로 멈춘 경우 제외)
    setTimeout(() => {
      if (currentProcess || stoppedByUser) return;
      if (queue.length > 0) {
        runNextInQueue();
      } else if (code === 0) {
        logs = [];
        broadcastLog('__CLEAR__');
      }
    }, 5000);
  });

  return null;
};

const runNextInQueue = () => {
  while (queue.length > 0 && !currentProcess) {
    const next = queue.shift();
    saveQueue();
    const err = startJob(next.url, next.chunkSize);
    if (!err) return;
    broadcastLog(`ERROR: 대기열 작업을 시작하지 못했습니다 (${next.url}): ${err}`);
    if (err.includes('폴더')) { queue.unshift(next); saveQueue(); return; }
  }
};

app.post('/api/start', (req, res) => {
  const { url } = req.body;
  const err = startJob(url, parseChunkSize(req.body.chunkSize));
  if (err) return res.status(400).json({ error: err });
  res.json({ success: true, message: 'Process started' });
});

app.get('/api/queue', (req, res) => {
  res.json(queue);
});

// 대기열에 추가. 실행 중인 작업이 없으면 바로 시작
app.post('/api/queue', (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: '올바른 URL을 입력해주세요.' });
  }
  if (url === currentUrl || queue.some(q => q.url === url)) {
    return res.status(400).json({ error: '이미 수집 중이거나 대기열에 있는 작품입니다.' });
  }
  queue.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url, chunkSize: parseChunkSize(req.body.chunkSize) });
  saveQueue();
  let started = false;
  if (!currentProcess) {
    runNextInQueue();
    started = !!currentProcess;
  }
  res.json({ success: true, started });
});

app.delete('/api/queue/:id', (req, res) => {
  queue = queue.filter(q => q.id !== req.params.id);
  saveQueue();
  res.json({ success: true });
});

app.post('/api/queue/start', (req, res) => {
  if (currentProcess) return res.status(400).json({ error: 'Process is already running' });
  if (queue.length === 0) return res.status(400).json({ error: '대기열이 비어 있습니다.' });
  runNextInQueue();
  if (!currentProcess) return res.status(400).json({ error: '대기열 작업을 시작하지 못했습니다. 로그를 확인해주세요.' });
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  if (currentProcess) {
    // SIGTERM으로 먼저 종료 요청 → 스크래퍼가 Chrome을 닫고 종료. 5초 내 안 끝나면 강제 종료
    const proc = currentProcess;
    try {
      proc.kill('SIGTERM');
    } catch(e) {}
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch(e) {}
        require('./browser_profile').killProfileBrowsers();
      }
    }, 5000);
    stoppedByUser = true;
    currentProcess = null;
    currentUrl = null;
    broadcastLog(`🔴 작업이 사용자에 의해 강제 중지되었습니다.${queue.length > 0 ? ' 대기열은 멈춘 상태로 유지됩니다.' : ''}`);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'No process is running' });
});

app.get('/api/status', (req, res) => {
  res.json({ isRunning: !!currentProcess, currentUrl: currentProcess ? currentUrl : null });
});

app.get('/api/history', (req, res) => {
  const fs = require('fs');
  const historyPath = path.join(__dirname, 'history.json');
  if (fs.existsSync(historyPath)) {
    try {
      let history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      history = history.map(item => typeof item === 'string' ? { url: item, title: item } : item);
      res.json(history);
    } catch(e) {
      res.json([]);
    }
  } else {
    res.json([]);
  }
});

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send existing logs
  logs.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });
  
  const client = { id: Date.now(), res };
  clients.push(client);
  
  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

app.post('/api/settings/save', (req, res) => {
  const fs = require('fs');
  try {
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.get('/api/settings/load', (req, res) => {
  const fs = require('fs');
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      res.json(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch(e) {
      res.json({ downloadPath: '', ebookPath: '' });
    }
  } else {
    res.json({ downloadPath: '', ebookPath: '' });
  }
});

app.get('/api/select-folder', (req, res) => {
  const { exec } = require('child_process');
  exec(`osascript -e 'POSIX path of (choose folder with prompt "Select Folder")'`, (error, stdout, stderr) => {
    if (error) {
      return res.json({ path: null });
    }
    res.json({ path: stdout.trim() });
  });
});

app.get('/api/files', (req, res) => {
  const fs = require('fs');
  let baseDir = path.join(require('os').homedir(), 'Downloads', 'Novel2Zip');
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
    if (settings.downloadPath) baseDir = settings.downloadPath;
  } catch(e) {}
  let result = [];
  
  if (fs.existsSync(baseDir)) {
    const items = fs.readdirSync(baseDir);
    items.forEach(item => {
      const itemPath = path.join(baseDir, item);
      if (fs.statSync(itemPath).isDirectory() && item !== 'ui' && item !== 'public' && !item.startsWith('.')) {
        const infoPath = path.join(itemPath, 'info.json');
        let info = null;
        if (fs.existsSync(infoPath)) {
          try {
            info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          } catch(e) {}
        }
        
        const files = fs.readdirSync(itemPath).filter(f => f.endsWith('.txt'));
        result.push({
          folder: item,
          info: info,
          fileCount: files.length,
          files: files.slice(0, 100) // limit to 100 to avoid huge payloads
        });
      }
    });
  }
  
  res.json(result);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`UI Server running at http://localhost:${PORT}`);
});
