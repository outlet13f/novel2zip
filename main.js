const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn, fork } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadURL('data:text/html,<h2>Loading App...</h2>');

  const fs = require('fs');
  const os = require('os');
  const logFile = path.join(os.homedir(), 'Desktop', 'novel2zip_log.txt');
  fs.writeFileSync(logFile, 'App Started\n');

  serverProcess = fork(path.join(__dirname, 'server.js'), [], { stdio: 'pipe' });
  
  let isLoaded = false;
  const loadUI = () => {
    if (!isLoaded) {
      isLoaded = true;
      fs.appendFileSync(logFile, 'Attempting to load UI...\n');
      mainWindow.loadURL('http://localhost:3000').then(() => {
        fs.appendFileSync(logFile, 'UI loaded successfully.\n');
      }).catch((e) => {
        fs.appendFileSync(logFile, `UI load failed: ${e.message}\n`);
        mainWindow.loadURL(`data:text/html,<h2>Load Failed</h2><p>${e.message}</p>`);
      });
    }
  };

  serverProcess.stdout.on('data', (data) => {
    const out = data.toString();
    fs.appendFileSync(logFile, `[STDOUT] ${out}`);
    if (out.includes('UI Server running at')) {
      loadUI();
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const err = data.toString();
    fs.appendFileSync(logFile, `[STDERR] ${err}`);
    if (err.includes('EADDRINUSE')) {
      fs.appendFileSync(logFile, 'Port in use, assuming server is running.\n');
      loadUI();
    }
  });
  
  serverProcess.on('error', (err) => {
    fs.appendFileSync(logFile, `[SPAWN ERROR] ${err.message}\n`);
  });

  serverProcess.on('exit', (code) => {
    fs.appendFileSync(logFile, `[EXIT] Server exited with code ${code}\n`);
  });

  // Timeout fallback
  setTimeout(() => {
    if (!isLoaded) {
      fs.appendFileSync(logFile, 'Timeout reached, force loading UI.\n');
      loadUI();
    }
  }, 3000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});
