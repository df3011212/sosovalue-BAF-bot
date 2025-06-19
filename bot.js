// bot.js
import 'dotenv/config';
import puppeteer from 'puppeteer';
import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 這段是為了取代 __dirname（ESM 沒有 __dirname）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const URL = 'https://sosovalue.com/tc/dashboard/fgi-indicator';
const INDEX_SEL = '.items-center.justify-center.rounded-sm .font-bold';
const DATE_SEL  = '.items-center.justify-center.rounded-sm .text-neutral-fg-4-rest';
const CANVAS_SEL = 'canvas[data-zr-dom-id="zr_0"]';

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
    await new Promise(r => setTimeout(r, 5000)); // 等載入

    const indexText = await page.$eval(INDEX_SEL, el => el.innerText.trim());
    const dateText  = await page.$eval(DATE_SEL , el => el.innerText.trim());

    const chart = await page.$(CANVAS_SEL);
    if (!chart) throw new Error('❌ 找不到 canvas 圖表區塊');

    const folder = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    const filename = `fgi-${new Date().toISOString().split('T')[0]}.png`;
    const filepath = path.join(folder, filename);

    await chart.screenshot({ path: filepath });

    console.log('📊 指數:', indexText);
    console.log('📅 日期:', dateText);
    console.log('🖼️ 已擷取圖表:', filename);

    const { BOT_TOKEN, CHAT_ID } = process.env;
    const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // 傳送文字
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `📈 *Fear & Greed Index*\n指數：*${indexText}*\n日期：${dateText}`,
      parse_mode: 'Markdown'
    });

    // 傳送圖片
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', `📊 恐懼與貪婪圖表\n日期：${dateText}`);
    form.append('photo', fs.createReadStream(filepath));

    await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity
    });

    console.log('✅ 已發送至 Telegram');

  } catch (err) {
    console.error('❌ 發生錯誤：', err.message);
  } finally {
    await browser.close();
  }
}

// 🕐 每天早上 08:00（台灣時間）
cron.schedule('0 0 8 * * *', runTask, {
  timezone: process.env.TZ || 'Asia/Taipei'
});

console.log('🟢 常駐任務已啟動，等待每天 08:00 自動執行...');
