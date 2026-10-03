const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sanitizeFilename = (name) => {
  if (!name) return 'Unknown';
  return name.replace(/[\\\\/:*?\\"<>|]/g, '').trim();
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 캡차 빈도 조절: 실제로 받은 화 수 기준으로 REST_EVERY화마다 3~5분 휴식
const REST_EVERY = 100;
const REST_MIN_MS = 3 * 60 * 1000;
const REST_MAX_MS = 5 * 60 * 1000;
const CAPTCHA_WAIT_MS = 10 * 60 * 1000;

// macOS 알림 (캡차를 놓치지 않도록)
const notify = (message) => {
  try {
    require('child_process').execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Novel2Zip" sound name "Glass"`]);
  } catch (e) {}
};

(async () => {
  try {
  const targetUrl = process.env.TARGET_URL;
  const fileFormat = process.env.FILE_FORMAT || 'episode_title';
  
  if (!targetUrl) {
    console.error('No TARGET_URL provided.');
    process.exit(1);
  }

  console.log(`Starting full scraper for URL: ${targetUrl}`);

  const getExecutablePath = () => {
    const os = require('os');
    const fs = require('fs');
    if (os.platform() === 'darwin') {
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (fs.existsSync(chromePath)) return chromePath;
    }
    return undefined;
  };
  // 실행이 끝나도 지우지 않는 고정 프로필 사용 → 서버 재시작/다음 작품에서도 캡차 통과 기록 유지
  // (실행 중 백그라운드↔창 전환 시에도 같은 프로필 공유)
  const { BROWSER_DATA_DIR: runDir, PROFILE_DIR: userDataDir, killProfileBrowsers } = require('./browser_profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  // 이전 실행이 강제 종료되며 남긴 Chrome 정리 (스크래퍼는 한 번에 하나만 실행됨)
  killProfileBrowsers();
  // 캡차 통과 기록이 세션 쿠키일 수 있음 → 브라우저를 다시 띄우거나 다음 실행 때 사라지지 않도록 저장/복원
  const cookiesPath = path.join(runDir, 'session-cookies.json');
  const saveCookies = async (b) => {
    try {
      const cookies = await b.cookies();
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    } catch (e) {
      console.log(`쿠키 저장 실패: ${e.message}`);
    }
  };
  const restoreCookies = async (b) => {
    try {
      if (!fs.existsSync(cookiesPath)) return;
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8')).map(c => {
        const data = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly };
        if (c.sameSite) data.sameSite = c.sameSite;
        if (!c.session && c.expires > 0) data.expires = c.expires;
        return data;
      });
      if (cookies.length > 0) await b.setCookie(...cookies);
    } catch (e) {
      console.log(`쿠키 복원 실패: ${e.message}`);
    }
  };
  const launchBrowser = async (headless) => {
    const b = await puppeteer.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: getExecutablePath(),
      userDataDir
    });
    await restoreCookies(b);
    return b;
  };
  // 브라우저 본문이 로드되거나 캡차가 뜰 때까지 대기. 'text' | 'captcha' 반환
  const waitForTextOrCaptcha = async (p, timeout) => {
    const handle = await p.waitForFunction(() => {
      if (window.__novelTTSText) return 'text';
      if (document.body && document.body.innerText.includes('퍼즐 조각을 맞춰주세요')) return 'captcha';
      return false;
    }, { timeout, polling: 500 });
    return handle.jsonValue();
  };

  let inVisibleBrowser = false;
  let browser = await launchBrowser('new');
  let page = await browser.newPage();

  // 중지 버튼(SIGTERM) 시 브라우저도 함께 종료
  const shutdown = async () => {
    await saveCookies(browser);
    try { await browser.close(); } catch (e) {}
    killProfileBrowsers();
    process.exit(1);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`Fetching main page...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Extract novel info
  const novelInfo = await page.evaluate(async () => {
    const titleEl = document.querySelector('.nd-info h1');
    const authorEl = document.querySelector('.nd-meta a');
    const coverEl = document.querySelector('.nd-thumb img');
    const descEl = document.querySelector('.nd-desc');
    const genreEls = document.querySelectorAll('.hero-v2-tag');
    
    const title = titleEl ? titleEl.innerText.trim() : 'Unknown';
    const author = authorEl ? authorEl.innerText.trim() : 'Unknown';
    const cover = coverEl ? coverEl.src : '';
    const desc = descEl ? descEl.innerText.trim() : '';
    const genres = Array.from(genreEls).map(el => el.innerText.trim());
    
    // Extract visible episodes from DOM
    const episodeNodes = document.querySelectorAll('li.novel-ep-row');
    let allEpisodes = Array.from(episodeNodes).map(el => {
      const linkEl = el.querySelector('a.novel-ep-link');
      const numEl = el.querySelector('.ne-num');
      const titleEl = el.querySelector('.ne-title');
      
      let epNumStr = numEl ? numEl.innerText.trim() : '';
      let epNum = epNumStr.replace(/[^0-9]/g, '');
      
      return {
        episode_number: epNum,
        title: titleEl ? titleEl.innerText.trim() : '',
        url: linkEl ? linkEl.href : ''
      };
    }).filter(ep => ep.url).reverse();
    
    // Try to get older episodes from the API
    const novelIdMatch = window.location.href.match(/\/novel\/(\d+)/);
    if (novelIdMatch) {
      const novelId = novelIdMatch[1];
      try {
        const html = document.documentElement.outerHTML;
        const cursorMatch = html.match(/olderCursor\\?":\\?"([^"\\]+)/);
        let cursor = cursorMatch ? cursorMatch[1] : null;
        let hasOlder = !!cursor;
        let apiItems = [];
        
        while (hasOlder && cursor) {
          let apiUrl = `/api/novel/${novelId}/episodes/window?direction=older&cursor=${encodeURIComponent(cursor)}`;
          const response = await fetch(apiUrl);
          if (!response.ok) break;
          
          const apiData = await response.json();
          if (apiData && apiData.items) {
            apiItems = apiItems.concat(apiData.items);
          }
          
          if (apiData && apiData.hasOlder && apiData.olderCursor) {
            hasOlder = true;
            cursor = apiData.olderCursor;
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
          } else {
            hasOlder = false;
          }
        }
        
        if (apiItems.length > 0) {
           const olderEpisodes = apiItems.map((ep, index) => ({
             episode_number: ep.number || ep.order || ep.episode_number || String(index + 1),
             title: ep.title || ep.name || '',
             url: window.location.origin + `/novel/${novelId}/${ep.id || ep.episode_id}`
           })).reverse();
           
           allEpisodes = [...olderEpisodes, ...allEpisodes];
        }
      } catch(e) {
        console.error("API fetch failed", e);
      }
    }
    
    return { title, author, cover, desc, genres, episodes: allEpisodes };
  });

  const bookTitle = novelInfo.title;
  const os = require('os');
  const outDir = path.join(process.env.DOWNLOAD_PATH || path.join(os.homedir(), 'Downloads', 'Novel2Zip'), sanitizeFilename(bookTitle));

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Save info.json
  const infoData = {
    title: novelInfo.title,
    author: novelInfo.author,
    cover: novelInfo.cover,
    description: novelInfo.desc,
    genres: novelInfo.genres,
    total_episodes: novelInfo.episodes.length,
    url: targetUrl
  };
  const infoPath = path.join(outDir, 'info.json');
  fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2));
  console.log(`Saved novel info to ${infoPath}`);
  console.log(`@@META@@${JSON.stringify(infoData)}`);

  const episodes = novelInfo.episodes;
  if (episodes.length === 0) {
    console.error('No episodes found on the page! Maybe we need to fetch via API.');
    await browser.close();
    killProfileBrowsers();
    process.exit(1);
  }

  console.log(`Found ${episodes.length} episodes. Starting download...`);

  let fetchedCount = 0;
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    console.log(`@@PROGRESS@@${JSON.stringify({ current: i + 1, total: episodes.length })}`);
    const safeTitle = sanitizeFilename(ep.title);
    
    let fileName = '';
    if (!safeTitle) {
      // If there is no title, just use the episode number
      fileName = `${ep.episode_number}.txt`;
    } else {
      if (fileFormat === 'book_title_episode') {
        fileName = `${sanitizeFilename(bookTitle)}_${safeTitle}_${ep.episode_number}.txt`;
      } else if (fileFormat === 'title_only') {
        fileName = `${safeTitle}.txt`;
      } else {
        fileName = `${ep.episode_number}_${safeTitle}.txt`;
      }
    }
    
    const filePath = path.join(outDir, fileName);

    if (fs.existsSync(filePath)) {
      console.log(`Skipping ${fileName} (already exists)`);
      continue;
    }

    let success = false;
    let retries = 3;

    while (retries > 0 && !success) {
      try {
        console.log(`Fetching [${i + 1}/${episodes.length}] ${ep.url}`);
        await page.goto(ep.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const state = await waitForTextOrCaptcha(page, 30000);
        if (state === 'captcha') {
          if (!inVisibleBrowser) {
            console.error('CAPTCHA DETECTED. 브라우저를 띄워 캡챠를 풉니다...');
            await saveCookies(browser);
            await browser.close();
            browser = await launchBrowser(false);
            inVisibleBrowser = true;
            page = await browser.newPage();
            await page.goto(ep.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } else {
            console.error('CAPTCHA DETECTED. 열려 있는 브라우저 창에서 캡챠를 풀어주세요...');
          }
          notify(`캡차가 나왔습니다. 브라우저 창에서 퍼즐을 맞춰주세요. (${ep.episode_number}화)`);
          await page.bringToFront();
          console.log(`${CAPTCHA_WAIT_MS / 60000}분 내에 브라우저에서 퍼즐을 맞춰주세요...`);
          await page.waitForFunction('window.__novelTTSText !== undefined && window.__novelTTSText !== ""', { timeout: CAPTCHA_WAIT_MS });
          // 백그라운드 브라우저로 바꾸면 브라우저 지문이 달라져 캡차가 다시 나올 수 있으므로 이 창을 계속 사용
          console.log('퍼즐이 풀렸습니다! 이 브라우저 창으로 계속 받습니다. (창을 닫지 마세요, 최소화는 괜찮습니다)');
          await saveCookies(browser);
        }
        const text = await page.evaluate(() => window.__novelTTSText);

        if (text && text.length > 50) {
          fs.writeFileSync(filePath, text, 'utf8');
          console.log(`Saved ${fileName} (${text.length} chars)`);
          await saveCookies(browser);
          success = true;
        } else {
          console.log(`Warning: Retrieved text is suspiciously short for ${ep.url}`);
          retries--;
        }
      } catch (e) {
        // 남은 재시도가 있으면 경고로만 표시 (재시도로 대부분 복구됨)
        if (retries > 1) {
          console.log(`⚠️ ${ep.episode_number}화 불러오기 실패, 다시 시도합니다 (${4 - retries}/3): ${e.message}`);
        } else {
          console.error(`Error fetching ${ep.url}: ${e.message}`);
        }

        try {
          if (!page.isClosed()) {
            await page.close();
          }
          page = await browser.newPage();
        } catch (recoverErr) {
          console.error("Failed to recover page:", recoverErr.message);
        }

        retries--;
        await delay(2000);
      }
    }

    if (!success) {
      console.error(`Failed to download episode ${ep.episode_number} after retries. (${ep.url})`);
    }

    await delay(5000 + Math.random() * 5000);

    fetchedCount++;
    if (fetchedCount % REST_EVERY === 0 && i < episodes.length - 1) {
      const restMs = REST_MIN_MS + Math.random() * (REST_MAX_MS - REST_MIN_MS);
      console.log(`☕ ${REST_EVERY}화를 받아 캡차 방지를 위해 ${Math.round(restMs / 60000)}분 쉽니다...`);
      await delay(restMs);
    }
  }

  await browser.close();
  killProfileBrowsers();
  console.log('Download complete.');

  // Automatically generate EPUB
  console.log('Generating EPUB...');
  const { execSync } = require('child_process');
  let epubOut = '';
  try {
    const ebookDir = process.env.EBOOK_PATH || path.join(require('os').homedir(), 'Downloads', 'Novel2Zip_Ebooks');
    if (!fs.existsSync(ebookDir)) {
      fs.mkdirSync(ebookDir, { recursive: true });
    }
    epubOut = path.join(ebookDir, `${sanitizeFilename(bookTitle)}.epub`);
    
    const txtToEpubPath = path.join(__dirname, 'txt_to_epub.js');
    execSync(`"${process.execPath}" "${txtToEpubPath}" "${outDir}" "${epubOut}" "${bookTitle}"`, { 
      stdio: 'inherit', 
      cwd: __dirname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    console.log(`Successfully generated EPUB at ${epubOut}`);
  } catch (err) {
    console.error('Error generating EPUB:', err);
  }

  // Upload to FTP if enabled
  try {
    const configPath = path.join('/Users/steve/DEv/novel2zip', 'config.json');
    if (fs.existsSync(configPath) && epubOut && fs.existsSync(epubOut)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.ftpEnable && config.ftpHost) {
        console.log('FTP upload enabled. Connecting to FTP server...');
        const ftp = require('basic-ftp');
        const client = new ftp.Client();
        client.ftp.verbose = true;
        try {
          await client.access({
            host: config.ftpHost,
            user: config.ftpUser,
            password: config.ftpPass,
            port: parseInt(config.ftpPort || '21'),
            secure: false
          });
          if (config.ftpPath) {
            await client.ensureDir(config.ftpPath);
          }
          const remoteFileName = path.basename(epubOut);
          console.log(`Uploading ${remoteFileName} to FTP...`);
          await client.uploadFrom(epubOut, remoteFileName);
          console.log('FTP upload completed successfully!');
        } catch (ftpErr) {
          console.error('FTP Upload Error:', ftpErr);
        }
        client.close();
      }
    }
  } catch(e) {
    console.error('FTP Check Error:', e);
  }
  } catch (err) {
    console.error(`FATAL ERROR: ${err.message}\\n${err.stack}`);
    process.exit(1);
  }
})();
