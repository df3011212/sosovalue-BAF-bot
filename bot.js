// bot.js（正式版：每日情緒分析 + 傳送 Telegram）
import 'dotenv/config';
import puppeteer from 'puppeteer';
import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const URL         = 'https://sosovalue.com/tc/dashboard/fgi-indicator';
const INDEX_SEL   = '.items-center.justify-center.rounded-sm .font-bold';
const DATE_SEL    = '.items-center.justify-center.rounded-sm .text-neutral-fg-4-rest';
const CANVAS_SEL  = 'canvas[data-zr-dom-id="zr_0"]';
const LAST_FILE   = path.join(__dirname, 'last_index.txt');

// === 情緒分級邏輯 ===
function evaluate(score) {
  const n = Number(score);
  if (n <= 20) return { level: '😱 極度恐懼', advice: '超跌區，可分批佈局' };
  if (n <= 40) return { level: '😟 恐懼', advice: '觀望或小倉試單' };
  if (n <= 60) return { level: '😐 中性', advice: '盤整期，等待方向' };
  if (n <= 80) return { level: '😏 貪婪', advice: '注意風控，逢高減碼' };
  return { level: '🤪 極度貪婪', advice: '警惕追高風險' };
}

function readLast() {
  return fs.existsSync(LAST_FILE) ? Number(fs.readFileSync(LAST_FILE, 'utf8')) : null;
}
function writeLast(val) {
  fs.writeFileSync(LAST_FILE, String(val));
}

async function runTask() {
  console.log('\n🚀 [任務啟動] ', new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 5000));

    const indexText = await page.$eval(INDEX_SEL, el => el.innerText.trim());
    const dateText  = await page.$eval(DATE_SEL , el => el.innerText.trim());
    const indexNum  = Number(indexText);

    const { level, advice } = evaluate(indexNum);
    const prev  = readLast();
    const diff  = prev !== null ? indexNum - prev : 0;
    const trendEmoji = diff === 0 ? '⏸' : diff > 0 ? '📈' : '📉';

    // 擷取圖表
    const chart = await page.$(CANVAS_SEL);
    if (!chart) throw new Error('❌ 找不到圖表 canvas');
    const folder = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    const filename = `fgi-${new Date().toISOString().split('T')[0]}.png`;
    const filepath = path.join(folder, filename);
    await chart.screenshot({ path: filepath });

    // 發送至 Telegram
    const { BOT_TOKEN, CHAT_ID } = process.env;
    const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // 1️⃣ 發送文字訊息
    const textMsg = 
`📊 *SoSoValue 恐懼與貪婪指數*（${dateText}）
今日分數：*${indexNum}*　${trendEmoji} ${diff > 0 ? '+' : ''}${diff}
情緒等級：*${level}*

📌 建議：${advice}`;
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text: textMsg,
      parse_mode: 'Markdown'
    });

    // 2️⃣ 發送圖表
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', `🖼️ 指數圖表（${dateText}）`);
    form.append('photo', fs.createReadStream(filepath));
    await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity
    });

    console.log('✅ 已成功發送至 Telegram！');
    writeLast(indexNum);
  } catch (err) {
    console.error('❌ 發生錯誤：', err.message);
  } finally {
    await browser.close();
  }
}

// ✅ 執行一次（也可換成排程）
runTask();
