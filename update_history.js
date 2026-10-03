const fs = require('fs');
const path = require('path');

const historyPath = path.join(__dirname, 'history.json');
let history = [];
if (fs.existsSync(historyPath)) {
  history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
}

const baseDir = '/Users/steve/Dev/novel2zip/Download';
let urlToTitle = {};

if (fs.existsSync(baseDir)) {
  const items = fs.readdirSync(baseDir);
  items.forEach(item => {
    const itemPath = path.join(baseDir, item);
    if (fs.statSync(itemPath).isDirectory()) {
      const infoPath = path.join(itemPath, 'info.json');
      if (fs.existsSync(infoPath)) {
        try {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          if (info.url && info.title) {
            urlToTitle[info.url] = info.title;
          }
        } catch(e) {}
      }
    }
  });
}

history = history.map(item => {
  if (typeof item === 'string') {
    return { url: item, title: urlToTitle[item] || item };
  }
  return item;
});

fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
console.log('History updated.');
