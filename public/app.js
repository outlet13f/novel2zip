document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('scraper-form');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const logContainer = document.getElementById('log-container');

  // 로그/작품 정보의 <, & 등이 태그로 해석되지 않도록 이스케이프
  const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Utility to append log to terminal
  const appendLog = (logObj) => {
    const el = document.createElement('div');
    el.className = 'log-entry';

    const timeStr = new Date(logObj.time).toLocaleTimeString();
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${timeStr}]`;
    el.appendChild(timeSpan);
    el.appendChild(document.createTextNode(` ${logObj.message}`));
    
    if (logObj.message.includes('ERROR') || logObj.message.includes('Failed')) {
      el.style.color = '#ef4444';
    } else if (logObj.message.includes('Saved')) {
      el.style.color = '#3b82f6';
    }
    
    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;
  };

  // Check initial status
  fetch('/api/status')
    .then(res => res.json())
    .then(data => {
      if (data.isRunning) {
        if (data.currentUrl) {
          document.getElementById('url').value = data.currentUrl;
        }
        setRunningState(true);
      }
    });

  // Connect to SSE for logs
  const evtSource = new EventSource('/api/logs');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.message === '__CLEAR__') {
      logContainer.innerHTML = '';
      document.getElementById('progress-container').style.display = 'none';
      return;
    }
    
    if (data.message.startsWith('@@QUEUE@@')) {
      try {
        queue = JSON.parse(data.message.substring(9));
        renderQueue();
      } catch (e) {
        console.error('Failed to parse QUEUE', e);
      }
      return;
    }

    if (data.message.startsWith('@@PROGRESS@@')) {
      try {
        const progJson = data.message.substring(12);
        const prog = JSON.parse(progJson);
        const container = document.getElementById('progress-container');
        const text = document.getElementById('progress-text');
        const percentText = document.getElementById('progress-percent');
        const bar = document.getElementById('progress-bar');
        
        container.style.display = 'block';
        text.innerText = `수집 중... (${prog.current} / ${prog.total})`;
        const percent = Math.floor((prog.current / prog.total) * 100);
        percentText.innerText = `${percent}%`;
        bar.style.width = `${percent}%`;
      } catch (e) {
        console.error('Failed to parse PROGRESS', e);
      }
      return;
    }
    
    if (data.message.startsWith('@@META@@')) {
      try {
        const metaJson = data.message.substring(8);
        const novel = JSON.parse(metaJson);
        const card = document.getElementById('current-novel-card');
        const infoDiv = document.getElementById('current-novel-info');
        
        const cover = novel.cover ? `<img src="${escapeHtml(novel.cover)}" style="width: 100px; height: 140px; object-fit: cover; border-radius: 6px; margin-right: 20px; float: left; box-shadow: 0 4px 6px rgba(0,0,0,0.1);" />` : '';
        const genres = escapeHtml(novel.genres && novel.genres.length > 0 ? novel.genres.join(', ') : '장르 정보 없음');
        const safeUrl = /^https?:\/\//i.test(novel.url || '') ? escapeHtml(novel.url) : '#';
        
        infoDiv.innerHTML = `
          <div style="display: flex;">
            ${cover}
            <div>
              <h3 style="margin-top: 0; margin-bottom: 8px; font-size: 1.25rem;">${escapeHtml(novel.title)} <span style="font-size: 0.9rem; color: #64748b; font-weight: normal;">by ${escapeHtml(novel.author)}</span></h3>
              <div style="margin-bottom: 8px;">
                <span style="display: inline-block; background: #e2e8f0; color: #475569; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; margin-right: 8px;">${genres}</span>
                <span style="display: inline-block; background: #dbeafe; color: #2563eb; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; margin-right: 8px;">총 ${escapeHtml(novel.total_episodes)}화</span>
                <a href="${safeUrl}" target="_blank" style="font-size: 0.85rem; color: #3b82f6; text-decoration: none; word-break: break-all;">${escapeHtml(novel.url)}</a>
              </div>
              <p style="font-size: 0.85rem; color: #475569; max-height: 80px; overflow-y: auto; line-height: 1.4;">${escapeHtml(novel.description || '설명 없음')}</p>
            </div>
          </div>
          <div style="clear: both;"></div>
        `;
        card.style.display = 'block';
      } catch (e) {
        console.error('Failed to parse META', e);
      }
      return;
    }
    
    appendLog(data);
    
    if (data.message.startsWith('Starting scraper for URL:')) {
      // 대기열에서 자동 시작된 작업도 화면에 반영
      resetProgressUI();
      const m = data.message.match(/^Starting scraper for URL: (\S+)/);
      if (m) document.getElementById('url').value = m[1];
      setRunningState(true);
      setTimeout(loadHistory, 1000);
    } else if (data.message.includes('exited with code') || data.message.includes('강제 중지')) {
      setRunningState(false);
    }
  };

  // 실행 중에도 URL/분할 입력은 열어둠 (대기열 추가용)
  let isRunningNow = false;
  const setRunningState = (isRunning) => {
    isRunningNow = isRunning;
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    renderQueue();
  };

  const resetProgressUI = () => {
    document.getElementById('current-novel-card').style.display = 'none';
    document.getElementById('progress-container').style.display = 'none';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-percent').innerText = '0%';
    document.getElementById('progress-text').innerText = '수집 준비 중...';
  };

  // 입력한 분할 단위 검사. 잘못되면 null
  const readChunkSize = () => {
    const chunkSize = parseInt(document.getElementById('chunk-size').value, 10);
    if (!Number.isInteger(chunkSize) || chunkSize < 0) {
      alert('EBOOK 분할 단위는 0 이상의 정수로 입력해주세요.');
      return null;
    }
    return chunkSize;
  };

  // Queue Logic
  let queue = [];
  const historyTitle = (url) => {
    const h = (allHistory || []).find(item => typeof item === 'object' && item.url === url);
    return h && h.title && h.title !== url ? h.title : null;
  };

  const renderQueue = () => {
    const card = document.getElementById('queue-card');
    const list = document.getElementById('queue-list');
    card.style.display = queue.length > 0 ? 'block' : 'none';
    document.getElementById('queue-count').textContent = `${queue.length}개`;
    document.getElementById('queue-start-btn').style.display = isRunningNow ? 'none' : 'inline-block';
    list.innerHTML = '';
    queue.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'queue-item';

      const num = document.createElement('span');
      num.className = 'q-num';
      num.textContent = idx + 1;

      const body = document.createElement('div');
      body.className = 'q-body';
      const title = document.createElement('div');
      title.className = 'q-title';
      title.textContent = historyTitle(item.url) || item.url;
      const meta = document.createElement('div');
      meta.className = 'q-meta';
      meta.textContent = `${item.chunkSize > 0 ? item.chunkSize + '화씩 분할' : '분할 안 함'} · ${item.url}`;
      body.appendChild(title);
      body.appendChild(meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'q-remove';
      remove.textContent = '삭제';
      remove.addEventListener('click', async () => {
        await fetch(`/api/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      });

      li.appendChild(num);
      li.appendChild(body);
      li.appendChild(remove);
      list.appendChild(li);
    });
  };

  const loadQueue = async () => {
    try {
      const res = await fetch('/api/queue');
      queue = await res.json();
      renderQueue();
    } catch (e) {
      console.error('Failed to load queue', e);
    }
  };

  document.getElementById('queue-add-btn').addEventListener('click', async () => {
    const urlInput = document.getElementById('url');
    if (!urlInput.reportValidity()) return;
    const chunkSize = readChunkSize();
    if (chunkSize === null) return;
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.value, chunkSize })
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || '대기열 추가 실패');
        return;
      }
      urlInput.value = '';
      setTimeout(loadHistory, 1000);
    } catch (err) {
      alert('Network error');
    }
  });

  document.getElementById('queue-start-btn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/queue/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) alert(data.error || '대기열 시작 실패');
    } catch (err) {
      alert('Network error');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = document.getElementById('url').value;
    const format = 'episode_title'; // Default format
    const chunkSize = readChunkSize();
    if (chunkSize === null) return;

    setRunningState(true);
    resetProgressUI();

    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format, chunkSize })
      });
      
      const data = await res.json();
      if (!data.success) {
        alert(data.error || 'Failed to start');
        setRunningState(false);
      }
    } catch (err) {
      alert('Network error');
      setRunningState(false);
    }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/stop', { method: 'POST' });
      setRunningState(false);
    } catch (err) {
      alert('Failed to stop');
    }
  });






  // Settings Logic
  const loadSettings = async () => {
    try {
      const res = await fetch('/api/settings/load');
      const data = await res.json();
      if (data) {
        document.getElementById('download-path').value = data.downloadPath || '';
        document.getElementById('ebook-path').value = data.ebookPath || '';
      }
    } catch(e) {
      console.error('Failed to load settings', e);
    }
  };

  document.getElementById('settings-save-btn').addEventListener('click', async () => {
    const config = {
      downloadPath: document.getElementById('download-path').value.trim(),
      ebookPath: document.getElementById('ebook-path').value.trim()
    };
    try {
      const res = await fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) alert('경로 설정이 저장되었습니다.');
      else alert('설정 저장 실패');
    } catch(e) {
      alert('네트워크 오류');
    }
  });

  // Load initial data
  loadSettings();
  
  // History Logic
  let allHistory = [];
  let historyVisibleCount = 5;

  const renderHistory = () => {
    const historyCard = document.getElementById('history-card');
    const historyList = document.getElementById('history-list');
    
    if (allHistory && allHistory.length > 0) {
      historyCard.style.display = 'block';
      historyList.innerHTML = '';
      
      const visibleData = allHistory.slice(0, historyVisibleCount);
      
      visibleData.forEach(item => {
        const url = typeof item === 'string' ? item : item.url;
        const title = typeof item === 'string' ? item : item.title;

        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.flexDirection = 'column';
        li.style.gap = '2px';
        li.style.padding = '8px';
        li.style.backgroundColor = '#27272a';
        li.style.borderRadius = '6px';
        
        const titleSpan = document.createElement('span');
        titleSpan.innerText = title;
        titleSpan.style.fontWeight = 'bold';
        titleSpan.style.fontSize = '0.95rem';
        titleSpan.style.color = '#f4f4f5';
        
        const a = document.createElement('a');
        a.href = '#';
        a.innerText = url;
        a.style.color = '#3b82f6';
        a.style.textDecoration = 'none';
        a.style.wordBreak = 'break-all';
        a.style.fontSize = '0.85rem';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('url').value = url;
        });
        
        li.appendChild(titleSpan);
        li.appendChild(a);
        historyList.appendChild(li);
      });

      let loadMoreBtn = document.getElementById('load-more-history-btn');
      if (allHistory.length > historyVisibleCount) {
        if (!loadMoreBtn) {
          loadMoreBtn = document.createElement('button');
          loadMoreBtn.id = 'load-more-history-btn';
          loadMoreBtn.className = 'btn primary';
          loadMoreBtn.innerText = '더보기';
          loadMoreBtn.style.marginTop = '12px';
          loadMoreBtn.style.width = '100%';
          loadMoreBtn.onclick = () => {
            historyVisibleCount += 5;
            renderHistory();
          };
          historyCard.appendChild(loadMoreBtn);
        } else {
          loadMoreBtn.style.display = 'block';
        }
      } else {
        if (loadMoreBtn) {
          loadMoreBtn.style.display = 'none';
        }
      }
    } else {
      historyCard.style.display = 'none';
    }
  };

  const loadHistory = async () => {
    try {
      const res = await fetch('/api/history');
      allHistory = await res.json();
      historyVisibleCount = 5;
      renderHistory();
      renderQueue(); // 대기열 항목 제목 갱신
    } catch(e) {
      console.error('Failed to load history', e);
    }
  };
  
  loadHistory();
  loadQueue();
  
  // Refresh history after a short delay when starting a scrape
  const originalSubmit = form.onsubmit;
  form.addEventListener('submit', () => {
    setTimeout(loadHistory, 1000);
  });
});

window.selectFolder = async (inputId) => {
  try {
    const res = await fetch('/api/select-folder');
    const data = await res.json();
    if (data.path) {
      document.getElementById(inputId).value = data.path;
    }
  } catch(e) {
    alert('폴더 선택 중 오류가 발생했습니다.');
  }
};
