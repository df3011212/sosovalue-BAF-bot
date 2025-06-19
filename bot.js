require('dotenv').config();
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const URL = 'https://sosovalue.com/tc/dashboard/fgi-indicator';
const INDEX_SEL = '.items-center.justify-center.rounded-sm .font-bold';
const DATE_SEL  = '.items-center.justify-center.rounded-sm .text-neutral-fg-4-rest';
const CANVAS_SEL = 'canvas[data-zr-dom-id="zr_0"]';

/** 主要工作：截圖 + 抓指數 + 發 Telegram */
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
    await new Promise(r => setTimeout(r, 5000));       // 等圖表/動畫

    // 抓數值
    const indexText = await page.$eval(INDEX_SEL, el => el.innerText.trim());
    const dateText  = await page.$eval(DATE_SEL , el => el.innerText.trim());

    // 截圖 canvas
    const canvas = await page.$(CANVAS_SEL);
    if (!canvas) throw new Error('找不到圖表 Canvas！');

    const dir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const filePath = path.join(dir, `fgi-${Date.now()}.png`);
    await canvas.screenshot({ path: filePath });

    console.log('📊 指數', indexText, '| 日期', dateText);
    console.log('🖼️ 圖片已存', filePath);

    // 發 Telegram（先傳文字，再傳圖）
    const { BOT_TOKEN, CHAT_ID } = process.env;
    const tg = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // ① 傳文字
    await axios.post(`${tg}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `📈 *Fear & Greed Index*\n指數：*${indexText}*\n日期：${dateText}`,
      parse_mode: 'Markdown'
    });

    // ② 傳圖片
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', `📊 Fear & Greed Index (${dateText})`);
    form.append('photo', fs.createReadStream(filePath));
    await axios.post(`${tg}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
    });

    console.log('✅ 已發送到 Telegram');
  } catch (err) {
    console.error('❌ 執行錯誤：', err.message);
  } finally {
    await browser.close();
  }
}

/* ---------- cron 排程 ---------- */
/**
 * cron 語法： 秒 分 時 日 月 週
 * 0 0 8 * * *  → 08:00:00 每天（系統時區由 process.env.TZ 控制）
 * Railway 預設 UTC，所以我們設定 TZ=Asia/Taipei
 */
cron.schedule('0 0 8 * * *', runTask, {
  timezone: process.env.TZ || 'Asia/Taipei',
});

console.log('🕙 已啟動常駐 bot，等待每日 08:00 執行…');
