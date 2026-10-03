const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const sanitizeFilename = (name) => {
  return name.replace(/[\\\\/:*?\\"<>|]/g, '').trim();
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

(async () => {
  const episodesPath = '/Users/steve/DEv/novel2zip/episodes.json';
  if (!fs.existsSync(episodesPath)) {
    console.error('episodes.json not found');
    process.exit(1);
  }

  const episodes = JSON.parse(fs.readFileSync(episodesPath, 'utf8'));
  if (episodes.length === 0) {
    console.log('No episodes to download');
    return;
  }

  const bookTitle = episodes[0].book_title || 'UnknownBook';
  const outDir = path.join('/Users/steve/DEv/novel2zip', sanitizeFilename(bookTitle));

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  // Set custom user agent just in case
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  console.log(`Starting download for ${episodes.length} episodes...`);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const safeTitle = sanitizeFilename(ep.title);
    const fileName = `${ep.episode_number}_${safeTitle}.txt`;
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
        
        await page.waitForFunction('window.__novelTTSText !== undefined && window.__novelTTSText !== ""', { timeout: 15000 });
        const text = await page.evaluate(() => window.__novelTTSText);

        if (text && text.length > 50) {
          fs.writeFileSync(filePath, text, 'utf8');
          console.log(`Saved ${fileName} (${text.length} chars)`);
          success = true;
        } else {
          console.log(`Warning: Retrieved text is suspiciously short for ${ep.url}`);
          retries--;
        }
      } catch (e) {
        console.error(`Error fetching ${ep.url}: ${e.message}`);
        
        // check for captcha
        try {
          const isCaptcha = await page.evaluate(() => document.body.innerText.includes('퍼즐 조각을 맞춰주세요'));
          if (isCaptcha) {
            console.error('CAPTCHA DETECTED. Please solve it in the opened browser window.');
            console.log('Waiting 60 seconds for you to solve it...');
            await page.waitForFunction('window.__novelTTSText !== undefined && window.__novelTTSText !== ""', { timeout: 60000 });
            console.log('Captcha solved! Continuing...');
            continue; // Retry this episode now that captcha is solved
          }
        } catch(ce) {}
        
        retries--;
        await delay(2000);
      }
    }

    if (!success) {
      console.error(`Failed to download episode ${ep.episode_number} after retries.`);
    }

    // Add a random delay to prevent rate limit / captcha (5s ~ 10s)
    await delay(5000 + Math.random() * 5000);
  }

  await browser.close();
  console.log('Download complete.');
})();
