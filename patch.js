const fs = require('fs');
let content = fs.readFileSync('download_full.js', 'utf8');
content = content.replace(/novel\\\\\\/\\(\\\\\\d\\+\\)/, 'novel\\/(\\d+)');
fs.writeFileSync('download_full.js', content);
