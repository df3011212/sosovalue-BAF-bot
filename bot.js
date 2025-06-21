/**********************************************************************
 * bot.js —— SoSoValue FGI + Coinglass Heatmap
 * 本地測試：若沒填 Telegram 環境變數，僅列印文字 & 圖片路徑
 * Node 18+ / puppeteer 22.x
 *********************************************************************/
import 'dotenv/config';
import puppeteer   from 'puppeteer';
import axios       from 'axios';
import fs          from 'fs';
import path        from 'path';
import cron        from 'node-cron';
import FormData    from 'form-data';
import dayjs       from 'dayjs';
import utc         from 'dayjs/plugin/utc.js';
import timezone    from 'dayjs/plugin/timezone.js';
import { fileURLToPath } from 'url';
import { dirname }      from 'path';

dayjs.extend(utc); dayjs.extend(timezone);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/* ---------- 共用 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad   = n  => n.toString().padStart(2,'0');
const SS_DIR = path.join(__dirname,'screenshots');
if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive:true });

async function pushToTG(img, caption){
  const { TELEGRAM_TOKEN:TOKEN, TELEGRAM_CHAT_ID:CHAT } = process.env;
  if (!TOKEN || !CHAT){
    console.log('\n⚠️ Telegram 變數未設定，只列印訊息：\n', caption);
    if (img) console.log('🖼️ 圖片路徑：', img);
    return;
  }
  if (img && fs.existsSync(img)){
    const form = new FormData();
    form.append('chat_id', CHAT);
    form.append('caption', caption);
    form.append('photo' , fs.createReadStream(img));
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`,
                     form,{headers:form.getHeaders()});
  }else{
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,
                     { chat_id:CHAT, text:caption });
  }
}

/* ================================================================
 *  Part A  —  SoSoValue Fear & Greed Index  (12:05)
 * ================================================================ */
const FGI_URL        = 'https://sosovalue.com/tc/dashboard/fgi-indicator';
const FGI_INDEX_SEL  = '.items-center.justify-center.rounded-sm .font-bold';
const FGI_DATE_SEL   = '.items-center.justify-center.rounded-sm .text-neutral-fg-4-rest';
const FGI_CANVAS_SEL = 'canvas[data-zr-dom-id]';
const LAST_FILE      = path.join(__dirname,'last_index.txt');

function readLast () {
  return fs.existsSync(LAST_FILE) ? Number(fs.readFileSync(LAST_FILE,'utf8')) : null;
}
function writeLast (v){ fs.writeFileSync(LAST_FILE,String(v)); }

function evaluateFGI (score){
  const n = Number(score);
  if (n<=20)  return { level:'😱 極度恐懼', advice:'超跌區，可分批佈局' };
  if (n<=40)  return { level:'😟 恐懼'    , advice:'觀望或小倉試單'   };
  if (n<=60)  return { level:'😐 中性'    , advice:'盤整期，等待方向' };
  if (n<=80)  return { level:'😏 貪婪'    , advice:'注意風控，逢高減碼' };
  return        { level:'🤪 極度貪婪', advice:'警惕追高風險'       };
}

async function fgiTask (){
  console.log('\n🚀 [FGI] 任務開始', new Date().toLocaleString());
  const browser = await puppeteer.launch({
    headless:'new',
    defaultViewport:{ width:1280, height:900 },
    args:['--no-sandbox','--disable-dev-shm-usage']
  });
  try{
    const page = await browser.newPage();
    await page.goto(FGI_URL, { waitUntil:'networkidle2' });
    await page.waitForSelector(FGI_INDEX_SEL,{timeout:15000});

    const indexTxt = await page.$eval(FGI_INDEX_SEL, el=>el.textContent.trim());
    const dateTxt  = await page.$eval(FGI_DATE_SEL , el=>el.textContent.trim());
    const indexNum = Number(indexTxt);

    /* emoji、diff、建議 */
    const { level, advice } = evaluateFGI(indexNum);
    const prev  = readLast();
    const diff  = prev!==null ? indexNum-prev : 0;
    const trend = diff===0 ? '⏸' : diff>0 ? '📈' : '📉';

    /* 截圖 */
    const chart = await page.$(FGI_CANVAS_SEL);
    if (!chart) throw new Error('找不到 FGI 圖表 canvas');
    const imgFile = path.join(SS_DIR, `fgi-${dayjs().format('YYYY-MM-DD')}.png`);
    await chart.screenshot({ path:imgFile });

    const caption =
`📊 SoSoValue 恐懼與貪婪指數（${dateTxt}）
今日分數：${indexNum}　${trend} ${diff>0?'+':''}${diff}
情緒等級：${level}

📌 建議：${advice}`;
    await pushToTG(imgFile, caption);
    console.log('✅ [FGI] 已推播完成');

    writeLast(indexNum);
  }catch(e){
    console.error('❌ [FGI] 錯誤：', e.message);
  }finally{
    await browser.close();
  }
}

/* ================================================================
 *  Part B  —  Coinglass Heatmap  (08:05)
 * ================================================================ */
const API_BASE = 'https://capi.coinglass.com/liquidity-heatmap/api/liquidity/v4/heatmap';
const API_KEY  = 'SILRRC6CXIUlotufdglZRUe95rTD9C+pUGhm/uzGGq4=';

const PAIRS = [
  { name:'BTCUSDT', symbol:'Binance_BTCUSDT#heatmap', tab:'Binance BTCUSDT' },
  { name:'ETHUSDT', symbol:'Binance_ETHUSDT#heatmap', tab:'Binance ETHUSDT' }
];

async function fetchHeatmap(symbol,ts){
  const { data } = await axios.get(API_BASE,{ params:{
    symbol, interval:'d1', startTime:ts, endTime:ts+86_400,
    minLimit:false, data:API_KEY
  }}).catch(()=>({data:null}));
  return data?.data?.data ?? null;
}

const pickTop = (map,avg)=>[...map.entries()]
  .filter(([,s])=>s>=avg*3)
  .sort((a,b)=>b[1]-a[1])
  .slice(0,5)
  .map(([price,size])=>({price,size}));

const fmt = (arr,label)=>arr.map((x,i)=>{
  const rank=i===0?'首要':i===1?'第二':'技術熱區';
  return `$${x.price} – ${rank}${label}`;
}).join('\n');

async function screenshotHeatmap(fixed){
  const stamp = `${fixed.getFullYear()}${pad(fixed.getMonth()+1)}${pad(fixed.getDate())}_${pad(fixed.getHours())}${pad(fixed.getMinutes())}`;
  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-dev-shm-usage'],
    defaultViewport:{ width:1600, height:1200 }
  });
  const page = await browser.newPage();
  await page.goto('https://www.coinglass.com/zh-TW/LiquidityHeatmap',{waitUntil:'networkidle2'});
  await sleep(6000);

  /* 切 24h */
  try{ await page.click('button:has-text("24小時")',{timeout:5000}); }
  catch{
    await page.evaluate(()=>{
      const b=[...document.querySelectorAll('button')].find(x=>/分鐘|小時|天/.test(x.textContent));
      b && b.click();
    });
    await sleep(800);
    await page.$$eval('ul[role="listbox"] li',lis=>{
      const t=lis.find(li=>li.textContent.trim()==='24小時');
      t&&t.click();
    });
  }
  await sleep(2000);

  for(const tgt of PAIRS){
    /* 精確 tab → 模糊備援 */
    const ok = await page.evaluate(tab=>{
      let b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===tab);
      if(!b){
        const key = tab.split(' ')[1]; // e.g. BTCUSDT
        b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(key));
      }
      return b ? (b.click(),true):false;
    }, tgt.tab);
    if(!ok){ console.warn(`⚠️ [Heatmap] 找不到 ${tgt.tab}`); continue; }
    await sleep(2000);

    const sel=`#coinglass-kline-${tgt.tab.replace(/ /g,'-')} canvas`;
    const cv = await page.$(sel);
    if(!cv){ console.warn(`⚠️ [Heatmap] ${tgt.name} canvas 缺失`); continue; }
    const img = path.join(SS_DIR, `${tgt.name.toLowerCase()}_${stamp}.png`);
    await cv.screenshot({ path:img });
    tgt.img = img;
    console.log(`📸 [Heatmap] ${tgt.name} → ${img}`);
  }
  await browser.close();
}

async function heatmapTask (){
  console.log('\n🚀 [Heatmap] 任務開始', new Date().toLocaleString());
  const now   = dayjs().tz('Asia/Taipei');
  const fixed = now.hour(8).minute(0).second(0).millisecond(0).toDate();
  const ts    = Math.floor(fixed.getTime()/1000);

  await screenshotHeatmap(fixed);

  for(const p of PAIRS){
    const raw = await fetchHeatmap(p.symbol, ts);
    if(!raw){ console.warn(`⚠️ [Heatmap] ${p.name} JSON 空值`); continue; }

    const [tsLast, bids=[], asks=[]] = raw.at(-1);
    const agg = arr=>{
      const m=new Map();
      arr.forEach(([pr,sz])=> m.set(+pr,(m.get(+pr)||0)+ +sz));
      return m;
    };
    const bidMap=agg(bids), askMap=agg(asks);
    const avgBid=bids.reduce((a,[,s])=>a+ +s,0)/(bids.length||1);
    const avgAsk=asks.reduce((a,[,s])=>a+ +s,0)/(asks.length||1);

    const sup=pickTop(bidMap,avgBid), res=pickTop(askMap,avgAsk);

    const caption =
`📊 ${p.name}（${dayjs.unix(tsLast).format('YYYY-MM-DD')}）

🔹 關鍵阻力區
${res.length?fmt(res,'阻力'):'(無資料)'}

🔹 關鍵支撐區
${sup.length?fmt(sup,'支撐'):'(無資料)'}`;
    await pushToTG(p.img, caption);
    console.log(`✅ [Heatmap] 已推播 ${p.name}`);
  }
}

/* ---------- 啟動：先跑一次 ---------- */
await fgiTask();
await heatmapTask();

/* ---------- CRON 排程 ---------- */
// 12:05 - FGI
cron.schedule('0 5 12 * * *', () => fgiTask().catch(console.error),
              { timezone:'Asia/Taipei' });

// 08:05 - Heatmap
cron.schedule('0 5 8 * * *', () => heatmapTask().catch(console.error),
              { timezone:'Asia/Taipei' });

console.log('🟢 Bot 常駐中，等待排程...');
