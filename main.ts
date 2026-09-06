import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const BASE='https://www.daraz.com.np';
const MARKET='6a4f8822-e1bc-4e8b-be61-4d1a400f3c13';
const SUPABASE_URL=process.env.SUPABASE_URL||'https://foupthwcnnskqlzhoyep.supabase.co';
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const CATEGORIES=['smartphone','tablet','laptop','desktop computer','printer','camera','smart tv','computer monitor','refrigerator','washing machine','air conditioner','dishwasher'];

type Item={title:string;url:string;itemId:string;price:number;image?:string;raw?:any};
type Product={title:string;url:string;itemId:string;price:number;image?:string;brand?:string;rating?:number;reviewCount?:number;specifications:Record<string,string>};
const clean=(v:any)=>String(v??'').replace(/\s+/g,' ').trim();
const num=(v:any)=>{const m=String(v??'').replace(/,/g,'').match(/\d+(?:\.\d+)?/);return m?Number(m[0]):undefined;};
const price=(v:any)=>{if(v==null)return undefined;if(typeof v==='number')return v;const s=clean(v);const m=s.match(/(?:Rs\.?|NPR)?\s*[\d,]+(?:\.\d+)?/i);return m?num(m[0]):num(s);};
const normalize=(v:any)=>{let x=String(v??'').replace(/\\\//g,'/').replace(/\\u002F/gi,'/').replace(/&amp;/gi,'&').trim();if(x.startsWith('//'))x='https:'+x;try{const u=new URL(x,BASE);return u.hostname.endsWith('daraz.com.np')?`${BASE}${u.pathname}`:x;}catch{return x;}};
const idOf=(u:string)=>u.match(/(?:\/i|\/products\/[^?#]*?-i)(\d+)/i)?.[1]||u;
const isProduct=(u:string)=>/\/(?:i\d+(?:-s\d+)?|products\/[^?#]*-i\d+(?:-s\d+)?)\.html/i.test(u);
async function get(url:string){const c=new AbortController();const t=setTimeout(()=>c.abort(),30000);try{const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9','X-Requested-With':'XMLHttpRequest','Referer':BASE+'/'}});return{status:r.status,type:r.headers.get('content-type')||'',text:await r.text()};}finally{clearTimeout(t);}}
function jsonRoot(text:string){try{return JSON.parse(text);}catch{return null;}}
function assignedJson(text:string,name:string){const marker=text.indexOf(name);if(marker<0)return null;const start=text.indexOf('{',marker+name.length);if(start<0)return null;let depth=0,inStr=false,esc=false;for(let i=start;i<text.length;i++){const ch=text[i];if(inStr){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inStr=false;continue;}if(ch==='"'){inStr=true;continue;}if(ch==='{')depth++;else if(ch==='}'&&--depth===0){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}}return null;}
function rootsFrom(text:string):any[]{const roots:any[]=[];const j=jsonRoot(text);if(j)roots.push(j,j?.data,j?.result,j?.data?.result);for(const name of ['window.pageData','window.__pageData__','pageData']){const x=assignedJson(text,name);if(x)roots.push(x,x?.data,x?.result,x?.data?.result);}return roots.filter(Boolean);}
function itemsFrom(text:string):any[]{for(const r of rootsFrom(text)){const x=r?.mods?.listItems||r?.data?.mods?.listItems||r?.result?.mods?.listItems||r?.items||r?.listItems;if(Array.isArray(x))return x;}return[];}
function makeItem(x:any):Item|undefined{const u=normalize(x?.itemUrl||x?.productUrl||x?.url||'');const n=String(x?.itemId||x?.item_id||x?.productId||'').match(/\d{6,}/)?.[0];const url=isProduct(u)?u:n?`${BASE}/i${n}.html`:'';if(!url)return;const p=price(x?.priceShow??x?.price??x?.salePrice??x?.sellingPrice??x?.discountPrice);return{title:clean(x?.name||x?.title||''),url,itemId:idOf(url),price:p??0,image:clean(x?.image||x?.imageUrl||x?.images?.[0])||undefined,raw:x};}
function extractItems(text:string):Item[]{const out=new Map<string,Item>();for(const x of itemsFrom(text)){const p=makeItem(x);if(p&&!out.has(p.itemId))out.set(p.itemId,p);}return[...out.values()];}

const BAD_KEYS=/^(type|class|id|src|href|style|alt|width|height|role|loading|decoding|itemprop|itemtype|itemscope|crossorigin|aria-|requestParams|request_params|itemId|item_id|productId|product_id|skuId|sku_id|sku|sellerId|seller_id|seller|sellerName|seller_name|itemUrl|productUrl|url|name|title|image|imageUrl|images|imageList|price|priceShow|price_show|salePrice|sale_price|discountPrice|discount_price|discount|originalPrice|original_price|originalPriceShow|original_price_show|currency|rating|ratingScore|ratings|review|reviews|reviewCount|reviewCountShow|shopId|shopName|brandId|brandName|categoryId|categoryName|categoryPath|tags|tracking|trackingInfo|analytics|query|searchTerm|search_term)$/i;
const BAD_VALUES=/^(img|image|text|script|style|div|span|html|body|null|undefined)$/i;
const canonical=(key:string)=>{const k=clean(key).toLowerCase();const map:Record<string,string>={brand:'Brand','brand name':'Brand','model':'Model','model name':'Model','colour':'Color','color':'Color','color family':'Color Family','capacity':'Capacity','type':'Product Type','product type':'Product Type','warranty period':'Warranty','warranty':'Warranty','weight':'Weight','dimensions':'Dimensions','dimension':'Dimensions'};return map[k]||clean(key);};
function add(out:Record<string,string>,key:any,value:any){const k=canonical(key);if(!k||BAD_KEYS.test(k)||k.length>100)return;const v=clean(value);if(!v||BAD_VALUES.test(v)||/^https?:\/\//i.test(v)||/^data:/i.test(v)||/<[^>]+>/i.test(v)||v.length>300)return;if(/\b(react|webpack|next\.js|crossorigin|hydration|tailwind)\b/i.test(v))return;out[k]=out[k]&&out[k]!==v?`${out[k]}; ${v}`:v;}
function collectObjectSpecs(root:any,out:Record<string,string>){if(!root||typeof root!=='object')return;if(Array.isArray(root)){for(const x of root)collectObjectSpecs(x,out);return;}for(const [k,v] of Object.entries(root)){if(v==null||BAD_KEYS.test(k))continue;if(typeof v==='string'||typeof v==='number'||typeof v==='boolean'){if(/^(Brand|Brand Name|Model|Model Name|Series|Color|Colour|Color Family|RAM|RAM Memory|Memory|Storage|Storage Capacity|ROM|Display|Screen|Screen Size|Resolution|Refresh Rate|Processor|CPU|GPU|Graphics|Chipset|Operating System|OS|Camera|Rear Camera|Front Camera|Battery|Battery Capacity|Network|SIM|SIM Type|Connectivity|WiFi|Bluetooth|Ports?|USB|HDMI|Dimensions?|Weight|Capacity|Power|Power Consumption|Voltage|Warranty|Warranty Period|Condition|Type|Product Type|Panel|Panel Type|Brightness|Response Time|Printer Type|Print Speed|Paper Size|Lens|Sensor|Megapixel|Zoom|Video|Refrigerant|Energy Rating|Wash Capacity|Spin Speed|Cooling Capacity|Inverter|Tonnage|Door Type|Installation Type)$/i.test(k))add(out,k,v);}else collectObjectSpecs(v,out);}}
async function extractRenderedSpecs(url:string){
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1366,height:900},userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(2500);
    const result=await page.evaluate(()=>{
      const clean=(v:any)=>String(v??'').replace(/\s+/g,' ').trim();
      const out:Record<string,string>={};
      const bad=(k:string)=>/^(type|class|id|src|href|style|alt|width|height|role|loading|decoding|itemprop|itemtype|itemscope|crossorigin|aria-|data-)/i.test(k);
      const add=(k:any,v:any)=>{k=clean(k);v=clean(v);if(!k||!v||bad(k)||v.length>300)return;out[k]=out[k]&&out[k]!==v?`${out[k]}; ${v}`:v;};
      for(const el of document.querySelectorAll('tr')){const c=[...el.querySelectorAll('th,td')].map(x=>clean(x.textContent)).filter(Boolean);if(c.length>=2)add(c[0],c.slice(1).join(' | '));}
      for(const el of document.querySelectorAll('dt')){const dd=el.nextElementSibling;if(dd?.tagName.toLowerCase()==='dd')add(el.textContent,dd.textContent);}
      for(const el of document.querySelectorAll('li,div,p,span')){const t=clean(el.textContent);const m=t.match(/^([^:]{2,100}):\s*(.{1,300})$/);if(m)add(m[1],m[2]);}
      const scripts=[...document.scripts].map(s=>s.textContent||'').filter(Boolean).join('\n');
      return {specs:out,html:document.documentElement.outerHTML,text:clean(document.body?.innerText||''),scripts};
    });
    const out:Record<string,string>={};
    collectObjectSpecs(assignedJson(result.scripts,'__NEXT_DATA__'),out);
    collectObjectSpecs(assignedJson(result.scripts,'pageData'),out);
    for(const [k,v] of Object.entries(result.specs)) add(out,k,v);
    return {specs:out,text:result.text,scripts:result.scripts};
  } finally { await browser.close(); }
}

async function save(p:Product,category:string,supabase:any){const row={title:p.title,price:p.price,currency:'NPR',image:p.image||null,link:p.url,reviews:p.reviewCount??null,rating:p.rating??null,search_term:category,website:'Daraz Nepal',marketplace_id:MARKET,external_id:p.itemId,specifications:p.specifications};const{data,error}=await supabase.from('products').upsert(row,{onConflict:'marketplace_id,external_id'}).select('id').single();if(error||!data?.id)throw new Error(error?.message||'product upsert failed');const id=data.id;const{error:e}=await supabase.from('product_enrichment_queue').upsert({product_id:id,brand:p.brand||null,model:p.specifications.Model||null,product_type:category,parse_status:'needs_review',reason:'Daraz URL browser specification collector',specifications:p.specifications,updated_at:new Date().toISOString()},{onConflict:'product_id'});if(e)console.log(`ENRICHMENT ERROR | ${p.itemId} | ${e.message}`);}

async function searchPage(query:string,page:number,minPrice:number){const q=encodeURIComponent(query);const offset=(page-1)*40;const priceFilter=`${Math.max(0,Math.floor(minPrice))}-999999999`;const candidates=[`${BASE}/catalog/?q=${q}&_keyori=ss&from=input&page=${page}&price=${priceFilter}`,`${BASE}/catalog/?ajax=true&q=${q}&_keyori=ss&from=input&page=${page}&price=${priceFilter}`];for(const url of candidates){const r=await get(url);const its=extractItems(r.text);console.log(`FETCH | page=${page} | status=${r.status} | type=${r.type} | bytes=${Buffer.byteLength(r.text)} | structured=${its.length}`);if(its.length)return{r,its};}return{r:await get(candidates[0]),its:[]};}

async function main(){await Actor.init();if(!KEY)throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');const input:any=(await Actor.getInput())||{};const productUrl=clean(input.productUrl||input.url||'');if(productUrl){const supabase=createClient(SUPABASE_URL,KEY);console.log(`PRODUCT_SPEC_START | url=${productUrl}`);const found=await extractRenderedSpecs(productUrl);const {data:existing}=await supabase.from('products').select('id,title,price,image,link,reviewCount,rating').eq('link',productUrl).limit(1).maybeSingle();let title=clean(input.title||existing?.title||'');let p:Product={title,url:productUrl,itemId:idOf(productUrl),price:Number(existing?.price||0),image:existing?.image||undefined,rating:Number(existing?.rating||0)||undefined,specifications:found.specs};if(!title){const m=found.text.match(/^.{0,300}/);title=clean(m?.[0]||'Daraz Product');p.title=title;}await save(p,'product-url',supabase);await Actor.pushData({url:productUrl,status:'updated',title:p.title,specifications:p.specifications});console.log(`PRODUCT_SPEC_DONE | specs=${Object.keys(p.specifications).length}`);await Actor.exit();return;}
const category=String(input.category||CATEGORIES[0]);const brand=clean(input.brand||'');const strictBrand=Boolean(input.strictBrand);const minPrice=Math.max(0,Number(input.minPrice??5000));const maxPages=Math.max(1,Math.min(100,Number(input.maxSearchPages||input.maxPages||100)));const query=clean(strictBrand&&brand?`${brand} ${category}`:category);const supabase=createClient(SUPABASE_URL,KEY);const seen=new Set<string>();let saved=0,low=0,empty=0;for(let page=1;page<=maxPages;page++){const{its}=await searchPage(query,page,minPrice);const fresh=its.filter(x=>!seen.has(x.itemId));for(const x of fresh)seen.add(x.itemId);for(const x of fresh){const p:Product={title:x.title,url:x.url,itemId:x.itemId,price:x.price,image:x.image,specifications:{}};if(!p.price||p.price<minPrice){low++;continue;}try{await save(p,query,supabase);await Actor.pushData(p);saved++;}catch(e){console.log(`SAVE ERROR | ${p.itemId} | ${e instanceof Error?e.message:String(e)}`);}}if(!its.length||!fresh.length){empty++;if(empty>=5)break;}else empty=0;}console.log(`DONE | unique=${seen.size} | saved=${saved} | below_${minPrice}_or_missing_price=${low}`);await Actor.exit();}
main().catch(async e=>{console.error(e);try{await Actor.fail();}catch{}});
