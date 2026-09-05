import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { load, type CheerioAPI } from 'cheerio';

const BASE = 'https://www.daraz.com.np';
const CATEGORY_SITEMAP = `${BASE}/sitemap-category-all.xml`;
const DARAZ_MARKETPLACE_ID = '6a4f8822-e1bc-4e8b-be61-4d1a400f3c13';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CATEGORIES: Record<string,string> = {
  smartphone:'smartphone', tablet:'tablet', laptop:'laptop', 'desktop computer':'desktop computer',
  printer:'printer', camera:'camera', 'smart tv':'smart tv', 'computer monitor':'computer monitor',
  refrigerator:'refrigerator', 'washing machine':'washing machine', 'air conditioner':'air conditioner', dishwasher:'dishwasher'
};
const CATEGORY_TERMS: Record<string,string[]> = {
  smartphone:['smartphone','iphone','phone','galaxy','redmi','poco','pixel','oneplus','oppo','vivo','realme','honor','nothing','nokia','motorola','infinix','tecno','itel','xiaomi','rog-phone','zenfone'],
  tablet:['tablet','ipad','galaxy-tab','redmi-pad','xiaomi-pad','lenovo-tab','tab-s','tab-a','matepad'],
  laptop:['laptop','macbook','thinkpad','ideapad','vivobook','zenbook','pavilion','aspire','inspiron','latitude','elitebook','probook','chromebook','yoga','surface-laptop','gram','rog-strix','tuf-gaming','nitro'],
  'desktop computer':['desktop','desktop-computer','all-in-one','aio-pc','gaming-pc','mini-pc','workstation'],
  printer:['printer','laserjet','deskjet','inkjet','ecotank','pixma','imageclass','mfp'],
  camera:['camera','mirrorless','dslr','cyber-shot','powershot','lumix','eos','alpha-a'],
  'smart tv':['smart-tv','android-tv','google-tv','qled','oled-tv','led-tv','television','tv-'],
  'computer monitor':['monitor','gaming-monitor','ultrawide','display','lcd-monitor','led-monitor'],
  refrigerator:['refrigerator','fridge','freezer','double-door-fridge','side-by-side'],
  'washing machine':['washing-machine','washer','dryer','washer-dryer','top-load-washer','front-load-washer'],
  'air conditioner':['air-conditioner','aircon','split-ac','inverter-ac','ac-'],
  dishwasher:['dishwasher','dish-washer']
};

type SearchProduct={title:string;url:string;itemId:string;price:number;originalPrice?:number;discount?:number;image?:string};
type Product=SearchProduct&{seller?:string;brand?:string;rating?:number;reviewCount?:number;specifications:Record<string,string>};

function clean(v:unknown){return String(v??'').replace(/\s+/g,' ').trim();}
function price(v:unknown):number|undefined{const m=String(v??'').replace(/,/g,'').match(/\d+(?:\.\d+)?/);if(!m)return;const n=Number(m[0]);return Number.isFinite(n)?n:undefined;}
function parsePriceText(v:unknown){const m=clean(v).match(/(?:Rs\.?|NPR)\s*[\d,]+(?:\.\d+)?/i);return m?price(m[0]):price(v);}
function normalizeUrl(v:string){try{const u=new URL(v,BASE);return `${u.origin}${u.pathname}`;}catch{return v;}}
function itemId(url:string){return url.match(/\/i(\d+)(?:-s\d+)?\.html/i)?.[1]||url;}
function isProductUrl(url:string){return /\/i\d+(?:-s\d+)?\.html(?:$|[?#])/i.test(url);}
function blocked(text:string){const t=text.toLowerCase();return ['verify you are human','captcha','are you a robot','unusual traffic','access denied','robot check'].some(x=>t.includes(x));}

async function httpGet(url:string,timeoutMs=30000){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);
  try{
    const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache'
    }});
    return{status:r.status,contentType:r.headers.get('content-type')||'',html:await r.text()};
  }finally{clearTimeout(timer);}
}

function xmlLocs(text:string){
  return [...text.matchAll(/<loc(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/loc>/gi)].map(m=>m[1]
    .replace(/^<!\[CDATA\[/i,'').replace(/\]\]>$/,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x2F;/gi,'/').trim()).filter(Boolean);
}

function addSpec(s:Record<string,string>,k:unknown,v:unknown){const key=clean(k),val=clean(v);if(!key||!val||key.length>150||val.length>2000)return;if(!s[key])s[key]=val;}
function tableSpecs($:CheerioAPI,s:Record<string,string>){$('table tr').each((_,r)=>{const c=$(r).find('th,td').map((_,e)=>clean($(e).text())).get().filter(Boolean);if(c.length>=2)addSpec(s,c[0],c.slice(1).join(' | '));});}
function labeledSpecs($:CheerioAPI,s:Record<string,string>){$('[class*="specification" i],[class*="specs" i],[class*="attribute" i],[class*="product-property" i]').each((_,b)=>{$(b).find('li,tr,p,div').each((_,r)=>{const c=$(r).children().map((_,e)=>clean($(e).text())).get().filter(Boolean);if(c.length>=2){addSpec(s,c[0],c.slice(1).join(' | '));return;}const t=clean($(r).text()),i=t.indexOf(':');if(i>1&&i<150)addSpec(s,t.slice(0,i),t.slice(i+1));});});}
function colonSpecs($:CheerioAPI,s:Record<string,string>){$('li,p,dt,dd').each((_,e)=>{const t=clean($(e).text()),i=t.indexOf(':');if(t.length>=3&&t.length<=600&&i>1&&i<120)addSpec(s,t.slice(0,i),t.slice(i+1));});}
function flatten(v:unknown,s:Record<string,string>,d=0){if(d>8||v==null)return;if(Array.isArray(v)){for(const x of v)flatten(x,s,d+1);return;}if(typeof v!=='object')return;for(const[k,x]of Object.entries(v as Record<string,unknown>)){const n=k.toLowerCase().replace(/[^a-z0-9]/g,'');if(['specifications','specification','attributes','attribute','productattributes','productspecifications','properties'].includes(n)){flatten(x,s,d+1);continue;}if(['string','number','boolean'].includes(typeof x)){if(d>=1)addSpec(s,k,x);}else if(d<5)flatten(x,s,d+1);}}
function jsonSpecs($:CheerioAPI,s:Record<string,string>){$('script[type="application/ld+json"],script').each((_,e)=>{let t=$(e).contents().text().trim();if(!t||t.length>1000000)return;const eq=t.indexOf('=');if(eq>=0&&t.slice(0,eq).includes('window'))t=t.slice(eq+1).replace(/;\s*$/,'');try{flatten(JSON.parse(t),s);}catch{}});}

function extractPdp(html:string,f:SearchProduct):Product{
  const $=load(html),s:Record<string,string>={};
  tableSpecs($,s);labeledSpecs($,s);colonSpecs($,s);jsonSpecs($,s);
  const title=clean($('meta[property="og:title"]').attr('content')||$('h1').first().text()||f.title);
  let finalPrice:number|undefined;
  for(const c of [$('meta[property="product:price:amount"]').attr('content'),$('meta[itemprop="price"]').attr('content'),$('[class*="pdp-price" i]').first().text(),$('[class*="price" i]').first().text()]){const n=parsePriceText(c);if(n&&n>0){finalPrice=n;break;}}
  let originalPrice:number|undefined;
  for(const c of [$('meta[itemprop="highPrice"]').attr('content'),$('del').first().text(),$('[class*="origin-price" i]').first().text(),$('[class*="original-price" i]').first().text()]){const n=parsePriceText(c);if(n&&n>0){originalPrice=n;break;}}
  const seller=clean($('[class*="seller-name" i] a').first().text()||$('[class*="seller" i] a').first().text())||undefined;
  const brand=s.Brand||s.brand||clean($('[itemprop="brand"]').first().text())||undefined;
  const image=$('meta[property="og:image"]').attr('content')||f.image;
  const rt=$('body').text().match(/([\d,]+)\s*(?:ratings|reviews)/i)?.[1];
  const reviewCount=rt?Number(rt.replace(/,/g,'')):undefined;
  return{...f,title,price:finalPrice??f.price,originalPrice,image,seller,brand,reviewCount,specifications:s};
}

function categoryTextMatch(url:string,category:string){
  const text=decodeURIComponent(url).toLowerCase().replace(/[-_/+%]+/g,' ');
  const terms=CATEGORY_TERMS[category]||[category];
  return terms.some(t=>text.includes(t.toLowerCase().replace(/[-_/+%]+/g,' ')));
}

function extractProductLinks(html:string):string[]{
  const $=load(html),out=new Set<string>();
  $('a[href]').each((_,e)=>{const href=$(e).attr('href');if(!href)return;const u=normalizeUrl(href);if(isProductUrl(u)&&new URL(u).hostname===new URL(BASE).hostname)out.add(u);});
  const raw=html.match(/https?:\/\/www\.daraz\.com\.np\/i\d+(?:-s\d+)?\.html/gi)||[];
  for(const x of raw)out.add(normalizeUrl(x.replace(/\\/g,'')));
  return [...out];
}

async function categoryUrls(category:string){
  const r=await httpGet(CATEGORY_SITEMAP,30000);
  if(r.status>=400)throw new Error(`Category sitemap HTTP ${r.status}`);
  const locs=xmlLocs(r.html);
  console.log(`CATEGORY SITEMAP | locs=${locs.length}`);
  const matches=locs.filter(u=>categoryTextMatch(u,category));
  console.log(`CATEGORY MATCH | category=${category} | matches=${matches.length}`);
  if(matches.length)console.log(`CATEGORY SAMPLE | ${matches.slice(0,5).join(' || ')}`);
  return matches;
}

async function discoverProductsFromCategories(category:string,maxCategoryPages:number,maxProducts:number){
  const cats=await categoryUrls(category);
  const candidates=new Set<string>();
  for(let i=0;i<cats.length&&i<maxCategoryPages&&candidates.size<maxProducts*5;i+=8){
    const batch=cats.slice(i,i+8);
    const results=await Promise.all(batch.map(async u=>{try{const r=await httpGet(u,30000);if(r.status>=400)throw new Error(`HTTP ${r.status}`);if(blocked(r.html))throw new Error('Daraz CAPTCHA/block detected on category page');return extractProductLinks(r.html);}catch(e){console.error(`CATEGORY PAGE FAILED ${u}:`,e instanceof Error?e.message:String(e));return[];}}));
    for(const links of results)for(const u of links)candidates.add(u);
    console.log(`CATEGORY PAGE PROGRESS ${Math.min(i+8,cats.length)}/${cats.length} | productUrls=${candidates.size}`);
  }
  return [...candidates].slice(0,maxProducts*5);
}

async function detail(url:string,minPrice:number):Promise<Product|null>{
  try{
    const id=itemId(url);const fallback:SearchProduct={title:'',url,itemId:id,price:0};
    const r=await httpGet(url);if(r.status>=400)throw new Error(`HTTP ${r.status}`);if(blocked(r.html))throw new Error('Daraz CAPTCHA/block detected on PDP');
    const p=extractPdp(r.html,fallback);
    if(!p.price||p.price<minPrice)return null;
    if(!p.title)throw new Error('PDP title missing');
    if(!Object.keys(p.specifications).length)console.warn(`HTTP PDP no parsed specs | ${id}`);
    return p;
  }catch(e){console.error(`HTTP PDP FAILED ${url}:`,e instanceof Error?e.message:String(e));return null;}
}

async function saveToSupabase(p:Product,category:string,query:string,supabase:ReturnType<typeof createClient>){
  const{data:row,error:e1}=await supabase.from('products').upsert({title:p.title,price:p.price,currency:'NPR',image:p.image||null,link:p.url,reviews:p.reviewCount??null,rating:p.rating??null,search_term:query,website:'Daraz Nepal',marketplace_id:DARAZ_MARKETPLACE_ID,external_id:p.itemId},{onConflict:'marketplace_id,external_id'}).select('id').single();
  if(e1||!row?.id)throw new Error(`products upsert failed: ${e1?.message||'missing id'}`);
  const productId=row.id as string;
  const{error:e2}=await supabase.from('price_history').insert({product_id:productId,price:p.price,currency:'NPR',captured_at:new Date().toISOString()});if(e2)throw new Error(`price_history failed: ${e2.message}`);
  const{error:e3}=await supabase.from('product_enrichment_queue').upsert({product_id:productId,brand:p.brand||null,model:p.specifications.Model||p.specifications['Model Name']||null,product_type:category,parse_status:'needs_review',reason:'Daraz HTTP PDP collector',specifications:p.specifications,updated_at:new Date().toISOString()},{onConflict:'product_id'});if(e3)throw new Error(`enrichment failed: ${e3.message}`);
  console.log(`SUPABASE SAVED | ${p.itemId} | NPR ${p.price} | specs=${Object.keys(p.specifications).length}`);
}

async function main(){
  await Actor.init();
  if(!SUPABASE_SERVICE_ROLE_KEY)throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
  const supabase=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  const input=(await Actor.getInput()||{}) as any;
  const category=String(input.category||'smartphone').trim().toLowerCase();
  if(!CATEGORIES[category])throw new Error(`Invalid category: ${category}`);
  const minPrice=Math.max(0,Number(input.minPrice??5000));
  const maxProducts=Math.max(1,Number(input.maxProducts||120));
  const pdpConcurrency=Math.max(1,Math.min(30,Number(input.pdpConcurrency||12)));
  const maxRunSeconds=Math.max(60,Number(input.maxRunSeconds||900));
  const maxCategoryPages=Math.max(1,Math.min(100,Number(input.maxCategoryPages||20)));
  const started=Date.now();
  console.log(`DARAZ NEPAL HTTP-ONLY CATEGORY SITEMAP | ${category} | minPrice=NPR ${minPrice} | maxProducts=${maxProducts} | categoryPages=${maxCategoryPages} | pdpConcurrency=${pdpConcurrency}`);

  const candidates=await discoverProductsFromCategories(category,maxCategoryPages,maxProducts);
  console.log(`PRODUCT CANDIDATES | category=${category} | candidates=${candidates.length}`);
  let saved=0,failed=0,scanned=0;

  for(let i=0;i<candidates.length&&saved<maxProducts&&!((Date.now()-started)>=maxRunSeconds*1000);i+=pdpConcurrency){
    const batch=candidates.slice(i,i+pdpConcurrency);
    const products=await Promise.all(batch.map(u=>detail(u,minPrice)));
    scanned+=batch.length;
    for(const p of products){
      if(!p){failed++;continue;}
      try{
        await saveToSupabase(p,category,category,supabase);
        await Actor.pushData({...p,category,marketplace:'Daraz Nepal',capturedAt:new Date().toISOString()});
        saved++;
      }catch(e){failed++;console.error(`SAVE FAILED ${p.itemId}:`,e instanceof Error?e.message:String(e));}
      if(saved>=maxProducts)break;
    }
    console.log(`PDP PROGRESS | scanned=${scanned} | saved=${saved} | failed=${failed}`);
  }
  console.log(`COMPLETE | category=${category} candidates=${candidates.length} scanned=${scanned} saved=${saved} failed=${failed}`);
  await Actor.exit();
}

main().catch(async e=>{console.error('FATAL',e);try{await Actor.exit();}catch{}process.exit(1);});
