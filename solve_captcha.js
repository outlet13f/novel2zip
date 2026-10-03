const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const delay = (ms) => new Promise(res => setTimeout(res, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: false }); // Show UI so we can see what's happening
  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  console.log(`Going to page that has CAPTCHA...`);
  await page.goto('https://sbxh9.com/novel/4591/4907609', { waitUntil: 'domcontentloaded' });
  
  try {
    const isCaptcha = await page.evaluate(() => document.body.innerText.includes('퍼즐 조각을 맞춰주세요'));
    if (isCaptcha) {
       console.log('Captcha found! Please solve it in the opened browser window.');
       console.log('Waiting up to 60 seconds for you to solve it...');
       
       // Wait until the captcha text goes away or novel content appears
       await page.waitForFunction('window.__novelTTSText !== undefined && window.__novelTTSText !== ""', { timeout: 60000 });
       
       console.log('Captcha solved or content loaded!');
       
       // Now save the cookies or just rely on the same session if we re-use it?
       // Let's just save cookies so our headless browser can use them.
       const cookies = await page.cookies();
       const fs = require('fs');
       fs.writeFileSync('/Users/steve/DEv/novel2zip/cookies.json', JSON.stringify(cookies, null, 2));
       console.log('Saved session cookies to cookies.json');
    } else {
       console.log('No captcha found on this page.');
    }
  } catch (e) {
    console.error('Error or timeout waiting for captcha resolution:', e);
  }
  
  await browser.close();
})();
