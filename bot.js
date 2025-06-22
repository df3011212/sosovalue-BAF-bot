// bot.js — SoSoValue FGI + Coinglass Heatmap 4H / 24H + AI 建議 (Node 18+ / Puppeteer 22)
import 'dotenv/config';
import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import FormData from 'form-data';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dayjs.extend(utc);
dayjs.extend(timezone);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ---------- 共用 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

async function pushToTG(img, caption) {
  const { TELEGRAM_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT } = process.env;
  if (!TOKEN || !CHAT) {
    console.log('\n⚠️  Telegram 未設定，只列印文字：\n', caption);
    if (img) console.log('🖼️ 圖片：', img);
    return;
  }
  if (img && fs.existsSync(img)) {
    const form = new FormData();
    form.append('chat_id', CHAT);
    form.append('caption', caption);
    form.append('photo', fs.createReadStream(img));
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, form, { headers: form.getHeaders() });
  } else {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: CHAT, text: caption });
  }
}

/* =========================================================
 * A. SoSoValue Fear & Greed Index  (每日 12:05)
 * =======================================================*/
const FGI_URL        = 'https://sosovalue.com/tc/dashboard/fgi-indicator';
const FGI_INDEX_SEL  = '.items-center.justify-center.rounded-sm .font-bold';
const FGI_DATE_SEL   = '.items-center.justify-center.rounded-sm .text-neutral-fg-4-rest';
const FGI_CANVAS_SEL = 'canvas[data-zr-dom-id]';
const LAST_FILE      = path.join(__dirname, 'last_index.txt');

const readLast  = () => fs.existsSync(LAST_FILE) ? Number(fs.readFileSync(LAST_FILE, 'utf8')) : null;
const writeLast = v => fs.writeFileSync(LAST_FILE, String(v));

function evaluateFGI(n) {
  if (n <= 20) return { level: '😱 極度恐懼', advice: '超跌區，可分批佈局' };
  if (n <= 40) return { level: '😟 恐懼',   advice: '觀望或小倉試單' };
  if (n <= 60) return { level: '😐 中性',   advice: '盤整期，等待方向' };
  if (n <= 80) return { level: '😏 貪婪',   advice: '注意風控，逢高減碼' };
  return            { level: '🤪 極度貪婪', advice: '警惕追高風險' };
}

async function fgiTask() {
  console.log('\n🚀 [FGI] 任務開始', new Date().toLocaleString());
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.goto(FGI_URL, { waitUntil: 'networkidle2' });
    await page.waitForSelector(FGI_INDEX_SEL, { timeout: 15000 });

    const indexNum = Number(await page.$eval(FGI_INDEX_SEL, el => el.textContent.trim()));
    const dateTxt  = await page.$eval(FGI_DATE_SEL,  el => el.textContent.trim());
    const { level, advice } = evaluateFGI(indexNum);

    const prev   = readLast();
    const diff   = prev !== null ? indexNum - prev : 0;
    const trend  = diff === 0 ? '⏸' : diff > 0 ? '📈' : '📉';

    const chart   = await page.$(FGI_CANVAS_SEL);
    const imgFile = path.join(SS_DIR, `fgi-${dayjs().format('YYYY-MM-DD')}.png`);
    await chart.screenshot({ path: imgFile });

    const caption =
`📊 SoSoValue 恐懼與貪婪指數（${dateTxt}）
今日分數：${indexNum}　${trend} ${diff>0?'+':''}${diff}
情緒等級：${level}

📌 建議：${advice}`;
    await pushToTG(imgFile, caption);
    writeLast(indexNum);
    console.log('✅ [FGI] 推播完成');
  } catch (e) {
    console.error('❌ [FGI] 錯誤：', e.message);
  } finally {
    await browser.close();
  }
}

/* =========================================================
 * B. Coinglass Heatmap 4H / 24H + AI 建議
 * =======================================================*/
const API_BASE = 'https://capi.coinglass.com/liquidity-heatmap/api/liquidity/v4/heatmap';
let   API_KEY  = '';

const PAIRS = [
  { name: 'BTCUSDT', symbol: 'Binance_BTCUSDT#heatmap', tab: 'Binance BTCUSDT' },
  { name: 'ETHUSDT', symbol: 'Binance_ETHUSDT#heatmap', tab: 'Binance ETHUSDT' }
];

const BINANCE_TICKER = s => `https://api.binance.com/api/v3/ticker/price?symbol=${s}`;
const getLastPrice   = async p => (await axios.get(BINANCE_TICKER(p))).data.price * 1;

/* 工具：取前 5 大支撐 / 阻力 */
const pickTop = (map, avg)=>[...map.entries()]
  .filter(([,s])=>s>=avg*3)
  .sort((a,b)=>b[1]-a[1])
  .slice(0,5)
  .map(([price])=>({price}));

/* 格式化 5 行輸出 */
const fmt = (arr,label)=>{
  const out=[];
  for(let i=0;i<5;i++){
    const tag=i===0?'首要':i===1?'第二':'技術熱區';
    out.push(arr[i]?`$${arr[i].price} – ${tag}${label}`:`— – ${tag}${label}`);
  }
  return out.join('\n');
};

/* AI 建議 */
function getAISuggestion(pair, price, supList, resList){
  if (!price || !supList.length || !resList.length)
    return '📌 資料不足，暫不建議操作。';

  const sup  = supList[0].price;
  const res  = resList[0].price;
  const step = pair.startsWith('BTC') ? 30 : 15;
  const near = step * 5;   // BTC±150、ETH±75

  if (price - sup <= near){
    const rr = (res - price) / (price - (sup - step*3));
    return `📈 建議進場：接近支撐 $${sup} 可掛多單
🎯 止盈目標：$${res}
🛑 停損設在：$${sup - step*3}
✅ RR 倍數：約 ${rr.toFixed(2)} 倍

📌 分批示範：
▶️ $${sup} / $${sup-step} / $${sup-step*2}`;
  }

  if (res - price <= near){
    const rr = (price - sup) / ((res + step*3) - price);
    return `📉 建議進場：接近阻力 $${res} 可掛空單
🎯 止盈目標：$${sup}
🛑 停損設在：$${res + step*3}
✅ RR 倍數：約 ${rr.toFixed(2)} 倍

📌 分批示範：
▶️ $${res} / $${res+step} / $${res+step*2}`;
  }

  return `📊 價格位於 $${sup} – $${res} 區間中段，RR 不佳，暫不建議進出場。`;
}

/* 取得最新 Heatmap token */
async function fetchToken(){
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('https://www.coinglass.com/zh-TW/LiquidityHeatmap', { waitUntil:'networkidle2' });
  const token = await page.evaluate(()=>localStorage.getItem('hmToken'));
  await browser.close();
  return token || 'SILRRC6CXIUlotufdglZRUe95rTD9C+pUGhm/uzGGq4=';
}

/* Heatmap 主任務 interval: '4h' 或 'd1' */
async function heatmapTask(interval='4h'){
  const label = interval==='4h' ? '4 小時圖' : '24 小時圖';
  const tag   = interval==='4h' ? '4h' : 'd1';

  console.log(`\n🚀 [Heatmap-${tag}] 任務開始`, new Date().toLocaleString());
  if(!API_KEY) API_KEY = await fetchToken();

  const now   = dayjs().tz('Asia/Taipei').minute(0).second(0).millisecond(0);
  const stamp = now.format('YYYYMMDD_HHmm');
  const ts    = Math.floor(now.valueOf()/1000);

  /* 1) 截圖 */
  const browser = await puppeteer.launch({
    headless:'new',
    defaultViewport:{ width:1600, height:1200 },
    args:['--no-sandbox','--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.goto('https://www.coinglass.com/zh-TW/LiquidityHeatmap', { waitUntil:'networkidle2' });
  await sleep(6000);
  const newToken = await page.evaluate(()=>localStorage.getItem('hmToken'));
  if(newToken) API_KEY = newToken;
  try{ await page.click('button:has-text("24小時")'); }catch{}
  await sleep(2000);

  for(const tgt of PAIRS){
    await page.evaluate(tab=>{
      const exact=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===tab);
      const fuzzy=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(tab.split(' ')[1]));
      (exact||fuzzy)?.click();
    }, tgt.tab);
    await sleep(2000);
    const sel = `#coinglass-kline-${tgt.tab.replace(/ /g,'-')}-heatmap canvas`;
    const cv  = await page.$(sel);
    if(!cv){ console.warn(`⚠️ ${tgt.name} canvas 缺失`); continue; }
    const img = path.join(SS_DIR, `${tgt.name.toLowerCase()}_${tag}_${stamp}.png`);
    await cv.screenshot({ path: img });
    tgt.img   = img;
    tgt.label = label;
  }
  await browser.close();

  /* 2) 解析 JSON & 推播 */
  for(const p of PAIRS){
    const { data } = await axios.get(API_BASE,{
      params:{
        symbol: p.symbol,
        interval,
        startTime: ts - (interval==='4h'?14400:86400),
        endTime: ts,
        minLimit:false,
        data: API_KEY
      }
    }).catch(()=>({data:null}));

    const d = data?.data?.data;
    if(!d){ console.warn(`⚠️ ${p.name} JSON 空值`); continue; }

    const [tsLast,bids=[],asks=[]] = d.at(-1);
    const sum = arr=>arr.reduce((a,[,s])=>a+ +s,0);
    const sup = pickTop(new Map(bids.map(([pr,sz])=>[+pr,+sz])), sum(bids)/(bids.length||1));
    const res = pickTop(new Map(asks.map(([pr,sz])=>[+pr,+sz])), sum(asks)/(asks.length||1));
    const price = await getLastPrice(p.name);

    const caption =
`📊 ${p.name}（${dayjs.unix(tsLast).format('YYYY-MM-DD HH:mm')})
${p.label ? `🕒 圖表類型：${p.label}\n` : ''}
🔹 關鍵阻力區
${fmt(res,'阻力')}

🔹 關鍵支撐區
${fmt(sup,'支撐')}

${getAISuggestion(p.name, price, sup, res)}`;


    await pushToTG(p.img, caption);
    console.log(`✅ [${p.name}] ${p.label} 推播完成`);
  }
}

/* ---------------- INIT & CRON ---------------- */
await fgiTask();        // 啟動：FGI
await heatmapTask('4h'); // 啟動：4H Heatmap

/* ► 排程設定 */
cron.schedule('0 5 12 * * *',   () => fgiTask().catch(console.error),   { timezone:'Asia/Taipei' });       // 每日 12:05 FGI
cron.schedule('0 0 0,4,8,12,16,20 * * *', () => heatmapTask('4h').catch(console.error), { timezone:'Asia/Taipei' }); // 4H 圖
cron.schedule('10 0 8 * * *',   () => heatmapTask('d1').catch(console.error), { timezone:'Asia/Taipei' });  // 每日 08:10 24H 圖

console.log('🟢 Bot 常駐中，等待排程...');
console.log('[DEBUG] TOKEN:', process.env.TELEGRAM_TOKEN);
