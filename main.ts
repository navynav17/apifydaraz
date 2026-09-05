import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { load, type CheerioAPI } from 'cheerio';

const BASE = 'https://www.daraz.com.np';
const DARAZ_MARKETPLACE_ID = '6a4f8822-e1bc-4e8b-be61-4d1a400f3c13';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CATEGORIES: Record<string, string> = {
  smartphone: 'smartphone', tablet: 'tablet', laptop: 'laptop',
  'desktop computer': 'desktop computer', printer: 'printer', camera: 'camera',
  'smart tv': 'smart tv', 'computer monitor': 'computer monitor',
  refrigerator: 'refrigerator', 'washing machine': 'washing machine',
  'air conditioner': 'air conditioner', dishwasher: 'dishwasher'
};

type SearchProduct = { title: string; url: string; itemId: string; price: number; originalPrice?: number; discount?: number; image?: string };
type Product = SearchProduct & { seller?: string; brand?: string; rating?: number; reviewCount?: number; specifications: Record<string, string> };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function clean(value: unknown): string { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function price(value: unknown): number | undefined { const m = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); if (!m) return undefined; const n = Number(m[0]); return Number.isFinite(n) ? n : undefined; }
function parsePriceText(value: unknown): number | undefined { const m = clean(value).match(/(?:Rs\.?|NPR)\s*[\d,]+(?:\.\d+)?/i); return m ? price(m[0]) : price(value); }
function normalizeUrl(value: string): string { try { const u = new URL(value, BASE); return `${u.origin}${u.pathname}`; } catch { return value; } }
function itemId(url: string): string { return url.match(/-i(\d+)(?:-s\d+)?\.html/i)?.[1] || url; }
function blocked(text: string): boolean { const t = text.toLowerCase(); return ['verify you are human','captcha','are you a robot','unusual traffic','access denied','robot check'].some(x => t.includes(x)); }

async function httpGet(url: string, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
    return { status: response.status, html: await response.text() };
  } finally { clearTimeout(timer); }
}

function addSpec(specifications: Record<string, string>, key: unknown, value: unknown) {
  const k = clean(key), v = clean(value);
  if (!k || !v || k.length > 150 || v.length > 2000) return;
  if (!specifications[k]) specifications[k] = v;
}

function collectTableSpecs($: CheerioAPI, specifications: Record<string, string>) {
  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').map((_, el) => clean($(el).text())).get().filter(Boolean);
    if (cells.length >= 2) addSpec(specifications, cells[0], cells.slice(1).join(' | '));
  });
}

function collectLabeledSpecs($: CheerioAPI, specifications: Record<string, string>) {
  $('[class*="specification" i], [class*="specs" i], [class*="attribute" i], [class*="product-property" i]').each((_, block) => {
    $(block).find('li,tr,p,div').each((_, row) => {
      const children = $(row).children().map((_, el) => clean($(el).text())).get().filter(Boolean);
      if (children.length >= 2) { addSpec(specifications, children[0], children.slice(1).join(' | ')); return; }
      const text = clean($(row).text()), idx = text.indexOf(':');
      if (idx > 1 && idx < 150) addSpec(specifications, text.slice(0, idx), text.slice(idx + 1));
    });
  });
}

function collectColonSpecs($: CheerioAPI, specifications: Record<string, string>) {
  $('li,p,dt,dd').each((_, el) => {
    const text = clean($(el).text());
    if (text.length < 3 || text.length > 600) return;
    const idx = text.indexOf(':');
    if (idx > 1 && idx < 120) addSpec(specifications, text.slice(0, idx), text.slice(idx + 1));
  });
}

function flattenObject(value: unknown, specifications: Record<string, string>, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const item of value) flattenObject(item, specifications, depth + 1); return; }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['specifications','specification','attributes','attribute','productattributes','productspecifications','properties'].includes(normalized)) {
      flattenObject(child, specifications, depth + 1); continue;
    }
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      if (depth >= 1) addSpec(specifications, key, child);
    } else if (depth < 5) flattenObject(child, specifications, depth + 1);
  }
}

function collectJsonSpecs($: CheerioAPI, specifications: Record<string, string>) {
  $('script[type="application/ld+json"],script').each((_, el) => {
    let text = $(el).contents().text().trim();
    if (!text || text.length > 1000000) return;
    const eq = text.indexOf('=');
    if (eq >= 0 && text.slice(0, eq).includes('window')) text = text.slice(eq + 1).replace(/;\s*$/, '');
    try { flattenObject(JSON.parse(text), specifications); } catch { /* non-JSON scripts are ignored */ }
  });
}

function extractSearch(html: string): SearchProduct[] {
  const $ = load(html), out: SearchProduct[] = [], seen = new Set<string>();
  $('a[href*="/products/"]').each((_, link) => {
    const href = normalizeUrl($(link).attr('href') || '');
    if (!href.includes('/products/')) return;
    let node: any = link;
    for (let depth = 0; depth < 8 && node; depth++) {
      const text = clean($(node).text());
      const matches = text.match(/(?:Rs\.?|NPR)\s*[\d,]+(?:\.\d+)?/gi) || [];
      const prices = matches.map(parsePriceText).filter((n): n is number => n !== undefined);
      if (text.length > 20 && prices.length) {
        const titleNode = $(node).find('[class*="title" i],[class*="name" i]').first();
        let title = clean(titleNode.text() || $(link).attr('title') || $(link).text());
        if (!title) title = text.split(/\n+/).map(clean).find(x => x.length > 15 && !/(?:Rs\.?|NPR)\s*[\d,]+/i.test(x)) || '';
        if (title && !seen.has(href)) {
          seen.add(href);
          const img = $(node).find('img').first(), dm = text.match(/(?:-|−)\s*(\d+)%/);
          out.push({ title, url: href, itemId: itemId(href), price: prices[0], originalPrice: prices.length > 1 ? Math.max(...prices) : undefined, discount: dm ? Number(dm[1]) : undefined, image: img.attr('src') || img.attr('data-src') || undefined });
        }
        break;
      }
      node = node.parent;
    }
  });
  return out;
}

function extractPdp(html: string, fallback: SearchProduct): Product {
  const $ = load(html), specifications: Record<string, string> = {};
  collectTableSpecs($, specifications);
  collectLabeledSpecs($, specifications);
  collectColonSpecs($, specifications);
  collectJsonSpecs($, specifications);

  const title = clean($('meta[property="og:title"]').attr('content') || $('span.pdp-mod-product-badge-title').first().text() || $('h1').first().text() || fallback.title);
  let finalPrice: number | undefined;
  for (const candidate of [$('meta[property="product:price:amount"]').attr('content'), $('meta[itemprop="price"]').attr('content'), $('[class*="pdp-price" i]').first().text(), $('[class*="price" i]').first().text()]) {
    const n = parsePriceText(candidate); if (n !== undefined && n > 0) { finalPrice = n; break; }
  }
  let originalPrice: number | undefined;
  for (const candidate of [$('meta[itemprop="highPrice"]').attr('content'), $('del').first().text(), $('[class*="origin-price" i]').first().text(), $('[class*="original-price" i]').first().text()]) {
    const n = parsePriceText(candidate); if (n !== undefined && n > 0) { originalPrice = n; break; }
  }
  const seller = clean($('[class*="seller-name" i] a').first().text() || $('[class*="seller" i] a').first().text()) || undefined;
  const brand = specifications.Brand || specifications.brand || clean($('[itemprop="brand"]').first().text()) || undefined;
  const image = $('meta[property="og:image"]').attr('content') || $('img.pdp-mod-common-image').first().attr('src') || fallback.image;
  const reviewText = $('body').text().match(/([\d,]+)\s*(?:ratings|reviews)/i)?.[1];
  const reviewCount = reviewText ? Number(reviewText.replace(/,/g, '')) : undefined;
  return { ...fallback, title, price: finalPrice ?? fallback.price, originalPrice: originalPrice ?? fallback.originalPrice, image, seller, brand, reviewCount, specifications };
}

async function search(query: string, n: number): Promise<SearchProduct[]> {
  const url = `${BASE}/catalog/?q=${encodeURIComponent(query)}&page=${n}`;
  console.log(`HTTP SEARCH ${n}: ${url}`);
  const response = await httpGet(url);
  if (response.status >= 400) throw new Error(`Daraz search HTTP ${response.status} on page ${n}`);
  if (blocked(response.html)) throw new Error(`Daraz CAPTCHA/block detected on search page ${n}`);
  return extractSearch(response.html);
}

async function detail(p: SearchProduct, minPrice: number): Promise<Product | null> {
  try {
    const response = await httpGet(p.url);
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
    if (blocked(response.html)) throw new Error('Daraz CAPTCHA/block detected on PDP');
    const product = extractPdp(response.html, p);
    if (!product.price || product.price < minPrice) return null;
    if (!Object.keys(product.specifications).length) console.warn(`HTTP PDP has no parsed specifications | ${p.itemId}`);
    return product;
  } catch (e) { console.error(`HTTP PDP FAILED ${p.url}:`, e instanceof Error ? e.message : String(e)); return null; }
}

async function saveToSupabase(product: Product, category: string, query: string, supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data: row, error: productError } = await supabase.from('products').upsert({
    title: product.title, price: product.price, currency: 'NPR', image: product.image || null, link: product.url,
    reviews: product.reviewCount ?? null, rating: product.rating ?? null, search_term: query, website: 'Daraz Nepal', marketplace_id: DARAZ_MARKETPLACE_ID, external_id: product.itemId
  }, { onConflict: 'marketplace_id,external_id' }).select('id').single();
  if (productError || !row?.id) throw new Error(`Supabase products upsert failed: ${productError?.message || 'missing product id'}`);
  const productId = row.id as string;
  const { error: historyError } = await supabase.from('price_history').insert({ product_id: productId, price: product.price, currency: 'NPR', captured_at: new Date().toISOString() });
  if (historyError) throw new Error(`Supabase price_history insert failed: ${historyError.message}`);
  const { error: enrichmentError } = await supabase.from('product_enrichment_queue').upsert({
    product_id: productId, brand: product.brand || null, model: product.specifications.Model || product.specifications['Model Name'] || null,
    product_type: category, parse_status: 'needs_review', reason: 'Daraz HTTP PDP collector', specifications: product.specifications, updated_at: new Date().toISOString()
  }, { onConflict: 'product_id' });
  if (enrichmentError) throw new Error(`Supabase enrichment upsert failed: ${enrichmentError.message}`);
  console.log(`SUPABASE SAVED | ${product.itemId} | NPR ${product.price} | specs=${Object.keys(product.specifications).length}`);
  return productId;
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const input = (await Actor.getInput() || {}) as any;
  const category = String(input.category || 'smartphone').trim().toLowerCase();
  if (!CATEGORIES[category]) throw new Error(`Invalid category: ${category}`);
  const query = CATEGORIES[category];
  const maxPages = Math.max(1, Math.min(1000, Number(input.maxPages || 1000)));
  const minPrice = Math.max(0, Number(input.minPrice ?? 5000));
  const pageDelayMs = Math.max(0, Number(input.pageDelayMs ?? 250));
  const pdpConcurrency = Math.max(1, Math.min(30, Number(input.pdpConcurrency ?? 12)));
  const maxRunSeconds = Math.max(60, Number(input.maxRunSeconds || 900));
  const startedAt = Date.now();
  console.log(`DARAZ NEPAL HTTP-ONLY | ${category} | query=${query} | minPrice=NPR ${minPrice} | pdpConcurrency=${pdpConcurrency} | maxRunSeconds=${maxRunSeconds}`);

  const seen = new Map<string, SearchProduct>();
  let pagesProcessed = 0, discovered = 0, saved = 0, failedPdp = 0, supabaseSaved = 0, supabaseFailed = 0;
  for (let n = 1; n <= maxPages; n++) {
    if (Date.now() - startedAt >= maxRunSeconds * 1000) break;
    const products = await search(query, n); pagesProcessed++; discovered += products.length;
    if (!products.length) { console.log(`NO PRODUCTS PAGE ${n}; stopping.`); break; }
    let added = 0;
    for (const p of products) {
      const url = normalizeUrl(p.url), pr = price(p.price), id = itemId(url);
      if (!pr || pr < minPrice || seen.has(id)) continue;
      seen.set(id, { ...p, url, itemId: id, price: pr }); added++;
    }
    console.log(`PAGE ${n}: discovered=${products.length}, newEligible=${added}, total=${seen.size}`);
    if (pageDelayMs) await sleep(pageDelayMs);
  }

  const queue = [...seen.values()];
  for (let start = 0; start < queue.length && Date.now() - startedAt < maxRunSeconds * 1000; start += pdpConcurrency) {
    const batch = queue.slice(start, start + pdpConcurrency);
    const results = await Promise.all(batch.map(p => detail(p, minPrice)));
    for (const d of results) {
      if (!d) { failedPdp++; continue; }
      try {
        await saveToSupabase(d, category, query, supabase); supabaseSaved++;
        await Actor.pushData({ ...d, category, searchQuery: query, marketplace: 'Daraz Nepal', currency: 'NPR', collectedAt: new Date().toISOString() }); saved++;
      } catch (e) { supabaseFailed++; console.error(`SUPABASE FAILED ${d.itemId}:`, e instanceof Error ? e.message : String(e)); }
    }
    console.log(`PDP BATCH | processed=${Math.min(start + pdpConcurrency, queue.length)}/${queue.length} saved=${saved}`);
  }

  await Actor.pushData({ _type: 'summary', category, searchQuery: query, pagesProcessed, discovered, eligibleProducts: queue.length, savedProducts: saved, failedPdp, supabaseSaved, supabaseFailed, minPrice, pdpConcurrency, collector: 'http-only', timeBudgetSeconds: maxRunSeconds, completedAt: new Date().toISOString() });
  console.log(`COMPLETE | HTTP-ONLY | pages=${pagesProcessed} discovered=${discovered} eligible=${queue.length} saved=${saved} failedPdp=${failedPdp} supabaseSaved=${supabaseSaved} supabaseFailed=${supabaseFailed}`);
  await Actor.exit();
}

main().catch(async e => { console.error('ACTOR FAILED:', e); try { await Actor.fail(e instanceof Error ? e.message : String(e)); } catch {} process.exit(1); });
