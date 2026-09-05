import { Actor } from 'apify';
import puppeteer, { Browser, Page } from 'puppeteer';

const BASE = 'https://www.daraz.com.np';
const CHROMIUM_PATH = '/usr/bin/chromium';
const CATEGORIES: Record<string, string> = {
  smartphone: 'smartphone', tablet: 'tablet', laptop: 'laptop',
  'desktop computer': 'desktop computer', printer: 'printer', camera: 'camera',
  'smart tv': 'smart tv', 'computer monitor': 'computer monitor',
  refrigerator: 'refrigerator', 'washing machine': 'washing machine',
  'air conditioner': 'air conditioner', dishwasher: 'dishwasher'
};

type SearchProduct = {
  title: string; url: string; itemId: string; price: number;
  originalPrice?: number; discount?: number; image?: string;
};
type Product = SearchProduct & {
  seller?: string; brand?: string; rating?: number; reviewCount?: number;
  specifications: Record<string, string>;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function price(value: unknown): number | undefined {
  const m = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeUrl(value: string): string {
  try {
    const u = new URL(value, BASE);
    return `${u.origin}${u.pathname}`;
  } catch { return value; }
}

function itemId(url: string): string {
  return url.match(/-i(\d+)(?:-s\d+)?\.html/i)?.[1] || url;
}

function blocked(text: string): boolean {
  const t = text.toLowerCase();
  return ['verify you are human','captcha','are you a robot','unusual traffic','access denied','robot check'].some(x => t.includes(x));
}

async function prepare(page: Page) {
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultNavigationTimeout(60000);
}

async function extractSearch(page: Page): Promise<SearchProduct[]> {
  const raw = await page.evaluate(`(() => {
    const out = [], seen = new Set();
    const clean = v => String(v || '').replace(/\\s+/g,' ').trim();
    const getPrices = text => (String(text||'').match(/(?:Rs\\.?|NPR)\\s*[\\d,]+(?:\\.\\d+)?/gi)||[])
      .map(x=>Number(x.replace(/Rs\\.?|NPR/gi,'').replace(/,/g,'').trim())).filter(Number.isFinite);
    for (const link of document.querySelectorAll("a[href*='/products/']")) {
      const href = link.href;
      if (!href || !href.includes('/products/')) continue;
      let node = link;
      for (let d=0; d<8 && node; d++) {
        const text = clean(node.innerText || node.textContent);
        const ps = getPrices(text);
        if (text.length > 20 && ps.length) {
          const titleNode = node.querySelector("[class*='title'],[class*='name']");
          let title = clean(titleNode?.textContent || link.getAttribute('title') || link.textContent);
          if (!title) title = text.split('\\n').map(clean).find(x=>x.length>15 && !/(?:Rs\\.?|NPR)\\s*[\\d,]+/i.test(x)) || '';
          if (title && !seen.has(href)) {
            seen.add(href);
            const img = node.querySelector('img');
            const dm = text.match(/(?:-\\s*)?(\\d+)%/);
            out.push({ title, url: href, price: ps[0], originalPrice: ps.length>1 ? Math.max(...ps) : undefined, discount: dm ? Number(dm[1]) : undefined, image: img?.src || img?.getAttribute('data-src') || undefined });
          }
          break;
        }
        node = node.parentElement;
      }
    }
    return out;
  })()`);
  return Array.isArray(raw) ? raw as SearchProduct[] : [];
}

async function extractPdp(page: Page) {
  return await page.evaluate(`(() => {
    const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const getPrice=v=>{const m=String(v||'').match(/(?:Rs\\.?|NPR)\\s*[\\d,]+(?:\\.\\d+)?/i);return m?Number(m[0].replace(/Rs\\.?|NPR/gi,'').replace(/,/g,'').trim()):null};
    const specifications={};
    const add=(k,v)=>{k=clean(k);v=clean(v);if(k&&v&&k.length<=150&&v.length<=1000) specifications[k]=v};
    for(const row of document.querySelectorAll('table tr')){const c=[...row.querySelectorAll('th,td')].map(x=>clean(x.textContent)).filter(Boolean);if(c.length>=2)add(c[0],c.slice(1).join(' | '));}
    for(const block of document.querySelectorAll("[class*='specification'],[class*='specs'],[class*='product-specification'],[class*='attribute']")){
      for(const row of block.querySelectorAll('li,div,p,tr')){
        const c=[...row.children].map(x=>clean(x.textContent)).filter(Boolean);
        if(c.length>=2){add(c[0],c.slice(1).join(' | '));continue;}
        const t=clean(row.textContent); const i=t.indexOf(':'); if(i>1)add(t.slice(0,i),t.slice(i+1));
      }
    }
    for(const el of document.querySelectorAll('li,div,p')){
      const t=clean(el.textContent); const i=t.indexOf(':');
      if(i>1&&t.length<500)add(t.slice(0,i),t.slice(i+1));
    }
    return {
      title: clean(document.querySelector('span.pdp-mod-product-badge-title')?.textContent || document.querySelector('h1')?.textContent),
      price: getPrice(document.querySelector('div.pdp-mod-product-price span.pdp-price')?.textContent),
      originalPrice: getPrice(document.querySelector('div.pdp-mod-product-price del')?.textContent),
      seller: clean(document.querySelector('div.seller-name__detail a')?.textContent || document.querySelector("[class*='seller'] a")?.textContent),
      image: document.querySelector('img.pdp-mod-common-image.gallery-preview-panel__image')?.src || document.querySelector('img')?.src,
      specifications
    };
  })()`);
}

async function search(page: Page, query: string, n: number): Promise<SearchProduct[]> {
  const url = `${BASE}/catalog/?q=${encodeURIComponent(query)}&page=${n}`;
  console.log(`SEARCH ${n}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const body = await page.evaluate(() => document.body?.innerText || '');
  if (blocked(body)) throw new Error(`Daraz CAPTCHA/block detected on search page ${n}`);
  return extractSearch(page);
}

async function detail(page: Page, p: SearchProduct, minPrice: number): Promise<Product | null> {
  try {
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1800);
    const body = await page.evaluate(() => document.body?.innerText || '');
    if (blocked(body)) throw new Error('Daraz CAPTCHA/block detected on PDP');
    const d = await extractPdp(page) as any;
    const finalPrice = d.price ?? p.price;
    if (!finalPrice || finalPrice < minPrice) return null;
    return { ...p, title: d.title || p.title, price: finalPrice, originalPrice: d.originalPrice || p.originalPrice, image: d.image || p.image, seller: d.seller || undefined, specifications: d.specifications || {} };
  } catch (e) {
    console.error(`PDP FAILED ${p.url}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function main() {
  await Actor.init();
  const input=(await Actor.getInput()||{}) as any;
  const category=String(input.category||'smartphone').trim().toLowerCase();
  if(!CATEGORIES[category]) throw new Error(`Invalid category: ${category}`);
  const query=CATEGORIES[category];
  const maxPages=Math.max(1,Math.min(1000,Number(input.maxPages||1000)));
  const minPrice=Math.max(0,Number(input.minPrice??5000));
  const pageDelayMs=Math.max(500,Number(input.pageDelayMs||1000));
  const detailDelayMs=Math.max(250,Number(input.detailDelayMs||500));
  const maxRunSeconds=Math.max(60,Number(input.maxRunSeconds||900));
  const startedAt=Date.now();
  const timedOut=()=>Date.now()-startedAt >= maxRunSeconds*1000;
  console.log(`DARAZ NEPAL | ${category} | query=${query} | minPrice=NPR ${minPrice} | maxRunSeconds=${maxRunSeconds}`);

  let browser:Browser|undefined;
  const seen=new Map<string,SearchProduct>();
  let pagesProcessed=0,discovered=0,failedPdp=0,saved=0;
  try {
    browser=await puppeteer.launch({ headless: 'new', executablePath: CHROMIUM_PATH, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote'] });
    const searchPage=await browser.newPage();
    const detailPage=await browser.newPage();
    await prepare(searchPage); await prepare(detailPage);

    for(let n=1;n<=maxPages;n++) {
      if(timedOut()){console.log('TIME BUDGET REACHED BEFORE SEARCH COMPLETE; stopping.');break;}
      const products=await search(searchPage,query,n);
      pagesProcessed++; discovered+=products.length;
      if(!products.length){console.log(`NO PRODUCTS PAGE ${n}; stopping.`);break;}
      let added=0;
      for(const p of products){
        const url=normalizeUrl(p.url),id=itemId(url),pr=price(p.price);
        if(!pr||pr<minPrice)continue;
        const key=id||url;
        if(seen.has(key))continue;
        seen.set(key,{...p,url,itemId:id,price:pr});added++;
      }
      console.log(`PAGE ${n}: discovered=${products.length}, newEligible=${added}, total=${seen.size}`);
      await sleep(pageDelayMs);
    }

    for(const p of seen.values()) {
      if(timedOut()){console.log(`TIME BUDGET REACHED DURING PDP PHASE; saved=${saved}, remaining=${Math.max(0,seen.size-saved)}`);break;}
      const d=await detail(detailPage,p,minPrice);
      if(!d){failedPdp++;continue;}
      await Actor.pushData({...d,category,searchQuery:query,marketplace:'Daraz Nepal',currency:'NPR',collectedAt:new Date().toISOString()});
      saved++;
      if(saved%10===0)console.log(`SAVED ${saved}/${seen.size}`);
      await sleep(detailDelayMs);
    }
    await Actor.pushData({_type:'summary',category,searchQuery:query,pagesProcessed,discovered,eligibleProducts:seen.size,savedProducts:saved,failedPdp,minPrice,timeBudgetSeconds:maxRunSeconds,completedAt:new Date().toISOString()});
    console.log(`COMPLETE | pages=${pagesProcessed} discovered=${discovered} eligible=${seen.size} saved=${saved} failedPdp=${failedPdp}`);
  } finally {
    if(browser)await browser.close();
    await Actor.exit();
  }
}

main().catch(async e=>{console.error('ACTOR FAILED:',e);try{await Actor.fail(e instanceof Error?e.message:String(e));}catch{}process.exit(1);});
