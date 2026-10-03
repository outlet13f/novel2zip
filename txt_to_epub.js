const fs = require('fs');
const path = require('path');
const Epub = require('epub-gen');

const inputDir = process.argv[2];
const outputFile = process.argv[3];
let bookTitle = process.argv[4];
let bookAuthor = process.argv[5];

if (!inputDir || !outputFile) {
  console.log("==========================================================");
  console.log("사용법: node txt_to_epub.js <텍스트파일_폴더경로> <출력파일명.epub> [책제목] [저자]");
  console.log("예시: node txt_to_epub.js ./절대회귀 ./절대회귀.epub");
  console.log("==========================================================");
  process.exit(1);
}

const episodesJsonPath = path.join(__dirname, 'episodes.json');
const infoJsonPath = path.join(inputDir, 'info.json');

if (!fs.existsSync(inputDir)) {
  console.error(`에러: 폴더를 찾을 수 없습니다 - ${inputDir}`);
  process.exit(1);
}

// 1. info.json에서 책 정보 가져오기 (가장 우선)
let coverUrl = null;
let description = "";
let publisher = "novel2zip";

if (fs.existsSync(infoJsonPath)) {
  try {
    const infoData = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
    console.log("✅ info.json 정보를 불러왔습니다.");
    if (!bookTitle && infoData.title) bookTitle = infoData.title;
    if (!bookAuthor && infoData.author) bookAuthor = infoData.author;
    if (infoData.cover) coverUrl = infoData.cover;
    if (infoData.description) description = infoData.description;
  } catch (e) {
    console.error("info.json 파일을 읽는 중 오류가 발생했습니다.", e);
  }
}

if (!bookTitle) bookTitle = 'Unknown Title';
if (!bookAuthor) bookAuthor = 'Unknown Author';

const files = fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.txt'));

if (files.length === 0) {
  console.error(`에러: 지정된 폴더에 txt 파일이 없습니다.`);
  process.exit(1);
}

// 숫자 기반 자연 정렬
files.sort((a, b) => {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
});

console.log(`총 ${files.length}개의 txt 파일을 찾았습니다. EPUB 변환을 시작합니다... (책 제목: ${bookTitle}, 저자: ${bookAuthor})`);

// 사용자 화면에서 입력한 분할 단위 (0 = 분할 안 함, 미지정 시 500)
const envChunk = parseInt(process.env.EPUB_CHUNK_SIZE, 10);
const MAX_CHAPTERS = Number.isInteger(envChunk) && envChunk >= 0 ? envChunk : 500;
const chunks = [];
if (MAX_CHAPTERS === 0) {
  chunks.push(files);
} else {
  for (let i = 0; i < files.length; i += MAX_CHAPTERS) {
    chunks.push(files.slice(i, i + MAX_CHAPTERS));
  }
}
console.log(`분할 단위: ${MAX_CHAPTERS === 0 ? '분할 안 함' : MAX_CHAPTERS + '화'} → ${chunks.length}권 생성`);

// 본문의 <, >, & 등이 태그로 해석되지 않도록 이스케이프 (예: "<상태창>")
const escapeHtml = (str) => str
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const generateEpub = async (chunkFiles, outPath, partIndex, totalParts) => {
  const content = chunkFiles.map((file) => {
    const filePath = path.join(inputDir, file);
    const text = fs.readFileSync(filePath, 'utf-8');
    
    let chapterTitle = path.parse(file).name; 
    // Remove the prefix number (e.g., "1_1화 프롤로그" -> "1화 프롤로그")
    chapterTitle = chapterTitle.replace(/^\d+_/, '');

    const htmlContent = text
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        return trimmed ? `<p>${escapeHtml(trimmed)}</p>` : '<br/>';
      })
      .join('');
    
    return {
      title: chapterTitle,
      data: htmlContent
    };
  });

  let currentTitle = bookTitle;
  if (totalParts > 1) {
    currentTitle = `${bookTitle} (${partIndex}/${totalParts})`;
  }

  const option = {
    title: currentTitle,
    author: bookAuthor,
    publisher: publisher,
    cover: localCoverPath || coverUrl, // URL 대신 로컬 경로 사용
    output: outPath,
    tocTitle: "목차",
    appendChapterTitles: true,
    content: content,
    css: "p { margin-bottom: 0.5em; line-height: 1.6; } br { display: block; margin: 10px 0; } h1, h2, h3 { text-align: center; margin-bottom: 20px; }"
  };

  try {
    await new Epub(option).promise;
    console.log(`✅ EPUB 변환 성공! 생성된 파일: ${outPath}`);
  } catch (err) {
    console.error(`❌ EPUB 변환 실패 (${outPath}):`, err);
  }
};

const https = require('https');
const http = require('http');

const downloadCover = (url, dest) => {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return downloadCover(redirectUrl, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download cover: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(dest);
      });
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
};

let localCoverPath = null;
(async () => {
  if (coverUrl && coverUrl.startsWith('http')) {
    try {
      console.log(`표지 다운로드 중... (${coverUrl})`);
      let ext = '.jpg';
      try { ext = path.extname(new URL(coverUrl).pathname) || '.jpg'; } catch(e) {}
      const coverDest = path.join(inputDir, `cover${ext}`);
      await downloadCover(coverUrl, coverDest);
      localCoverPath = coverDest;
      console.log(`✅ 표지 다운로드 완료: ${localCoverPath}`);
    } catch (e) {
      console.error(`❌ 표지 다운로드 실패:`, e.message);
    }
  } else if (coverUrl && fs.existsSync(coverUrl)) {
    localCoverPath = coverUrl;
  } else if (coverUrl && fs.existsSync(path.join(inputDir, coverUrl))) {
    localCoverPath = path.join(inputDir, coverUrl);
  }

  if (chunks.length === 1) {
    await generateEpub(chunks[0], outputFile, 1, 1);
  } else {
    const ext = path.extname(outputFile);
    const base = outputFile.slice(0, -ext.length);
    for (let i = 0; i < chunks.length; i++) {
      const partOutput = `${base}_${i + 1}${ext}`;
      await generateEpub(chunks[i], partOutput, i + 1, chunks.length);
    }
  }
})();
