const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');

// ── LOGGING ──
function log(stage, msg, data = '') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${stage}] ${msg}`, data || '');
}

function logError(stage, msg, err) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${stage}] ERROR: ${msg}`, err?.message || err || '');
}

// ── RANDOM DELAY ──
function randomDelay(range) {
  const [min, max] = range;
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

// ── GOOGLE SHEETS AUTH ──
function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SHEET_ID = process.env.FARMERSHARVEST_SHEET_ID;
const SHEET_NAME = 'Sheet1';

// ── ENSURE HEADERS ──
async function ensureHeaders(sheets) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!A1:H1` });
  const row = r.data.values?.[0];
  if (!row || row.length === 0 || row[0] !== 'Platform') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A1:H1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Platform', 'Creator', 'Title/Caption', 'Link', 'Views', 'Date Posted', 'Date Discovered', 'Usage Rights']] },
    });
    log('SHEETS', 'Headers created');
  }
}

// ── LOAD EXISTING LINKS FROM SHEET (for deduplication) ──
async function loadExistingLinks(sheets) {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!D:D` });
    const links = (r.data.values || []).map(row => row[0]).filter(Boolean);
    log('SHEETS', `Loaded ${links.length} existing links from sheet`);
    return new Set(links);
  } catch (err) {
    logError('SHEETS', 'Could not load existing links', err);
    return new Set();
  }
}

// ── APPEND NEW ROWS TO SHEET ──
async function appendToSheet(sheets, results) {
  if (results.length === 0) {
    log('SHEETS', 'No new results to add');
    return;
  }
  const rows = results.map(r => [
    'TikTok',
    r.creator || '',
    r.title || '',
    r.url || '',
    r.views || 'N/A',
    r.date || '',
    new Date().toISOString().split('T')[0],
    'FALSE',
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_NAME}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  log('SHEETS', `Appended ${rows.length} new rows to sheet`);
}

// ── SAVE SCREENSHOT ON ERROR ──
async function saveDebugSnapshot(page, keyword, stage) {
  try {
    const dir = path.resolve('./debug-snapshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `${stage}-${keyword.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`;
    await page.screenshot({ path: `${dir}/${filename}.png`, fullPage: false });
    const html = await page.content();
    fs.writeFileSync(`${dir}/${filename}.html`, html);
    log('DEBUG', `Saved snapshot: ${filename} (HTML length: ${html.length} chars)`);
  } catch (e) {
    logError('DEBUG', 'Could not save debug snapshot', e);
  }
}

// Keep old name as alias for any remaining references
const saveErrorScreenshot = saveDebugSnapshot;

// ── PARSE DATE ──
function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  try {
    const d = new Date(dateStr);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  } catch (e) {}
  return dateStr;
}

// ── SCRAPE ONE KEYWORD ──
async function scrapeKeyword(page, keyword, existingUrls) {
  const results = [];
  log('SEARCH', `Searching for: ${keyword}`);

  try {
    // Navigate to TikTok search
    const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
    log('NAVIGATE', `Going to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give TikTok's JS time to render search results — this is a heavily client-rendered page
    try {
      await page.waitForSelector('a[href*="/video/"]', { timeout: 8000 });
      log('NAVIGATE', 'Video links appeared in DOM');
    } catch (e) {
      log('NAVIGATE', 'Video links did not appear within 8s — page may have served a fallback/error state');
    }
    await randomDelay(config.delays.pageLoad);

    // Check if page loaded
    const title = await page.title();
    log('NAVIGATE', `Page title: ${title}`);

    // Detect TikTok's "something went wrong" error state early
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    if (/something went wrong|sorry, something/i.test(bodyText)) {
      log('NAVIGATE', `⚠️ TikTok served an error page for this search. Body preview: "${bodyText.slice(0, 150)}"`);
    } else {
      log('NAVIGATE', `Body preview: "${bodyText.slice(0, 150)}"`);
    }

    // Scroll to load more results
    log('SCROLL', 'Scrolling through results...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await randomDelay(config.delays.betweenScrolls);
      log('SCROLL', `Scroll ${i + 1}/5`);
    }

    // Extract video links
    log('PARSE', 'Extracting video data...');
    let links = [];

    // ALWAYS save a debug screenshot + HTML dump for this keyword so we can see exactly what TikTok served us
    await saveDebugSnapshot(page, keyword, 'after-scroll');

    // Try primary selector
    try {
      links = await page.$$eval(config.selectors.videoLinks, els =>
        els.map(el => ({
          url: el.href,
          text: el.textContent?.trim() || ''
        })).filter(l => l.url && l.url.includes('/video/'))
      );
      log('PARSE', `Found ${links.length} links with primary selector`);
    } catch (err) {
      logError('PARSE', 'Primary selector failed', err);
    }

    // If primary selector found nothing, try every fallback selector
    if (links.length === 0) {
      log('PARSE', 'Primary selector found 0 — trying fallbacks...');
      for (const fallback of config.fallbackSelectors.videoLinks) {
        try {
          const found = await page.$$eval(fallback, els =>
            els.map(el => ({ url: el.href, text: el.textContent?.trim() || '' }))
               .filter(l => l.url && l.url.includes('tiktok.com'))
          );
          log('PARSE', `Fallback "${fallback}" found ${found.length} links`);
          if (found.length > 0) { links = found; break; }
        } catch (e) {
          logError('PARSE', `Fallback "${fallback}" threw an error`, e);
        }
      }
    }

    // Last resort — grab EVERY anchor tag on the page and filter for video URLs in JS
    if (links.length === 0) {
      log('PARSE', 'All selectors found 0 — grabbing every anchor tag as last resort...');
      try {
        const allLinks = await page.$$eval('a', els => els.map(el => ({ url: el.href, text: el.textContent?.trim() || '' })));
        log('PARSE', `Page has ${allLinks.length} total anchor tags`);
        links = allLinks.filter(l => l.url && /\/video\/\d+/.test(l.url));
        log('PARSE', `Of those, ${links.length} match the /video/ID pattern`);
      } catch (e) {
        logError('PARSE', 'Even grabbing all anchors failed', e);
      }
    }

    // Deduplicate and process
    const seen = new Set();
    for (const link of links.slice(0, config.maxResultsPerKeyword)) {
      if (!link.url || seen.has(link.url) || existingUrls.has(link.url)) continue;
      seen.add(link.url);

      // Extract video ID from URL
      const videoIdMatch = link.url.match(/\/video\/(\d+)/);
      const videoId = videoIdMatch ? videoIdMatch[1] : null;

      // Extract username from URL
      const usernameMatch = link.url.match(/@([^/]+)/);
      const username = usernameMatch ? '@' + usernameMatch[1] : 'Unknown';

      results.push({
        id: videoId || Date.now().toString(),
        url: link.url,
        title: link.text || keyword + ' content',
        creator: username,
        date: new Date().toISOString().split('T')[0],
        views: 'N/A',
        viewsNum: 0,
        platform: 'tt',
        keyword: keyword,
        type: 'short',
        discoveredAt: new Date().toISOString(),
      });
    }

    log('PARSE', `Extracted ${results.length} new results for keyword: ${keyword}`);

  } catch (err) {
    logError('SEARCH', `Failed to scrape keyword: ${keyword}`, err);
    await saveErrorScreenshot(page, keyword, 'search');
  }

  return results;
}

// ── MAIN ──
async function main() {
  log('START', '🌱 FarmersHarvest TikTok Scraper starting...');
  log('START', `Keywords: ${config.keywords.join(', ')}`);

  let existingUrls = new Set();
  let sheets;

  try {
    sheets = getSheetsClient();
    await ensureHeaders(sheets);
    existingUrls = await loadExistingLinks(sheets);
  } catch (err) {
    logError('SHEETS', 'Could not connect to Google Sheets — falling back to local file', err);
  }

  let allNew = [];

  let browser;
  try {
    log('BROWSER', 'Launching Chromium...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 850 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Remove the navigator.webdriver flag and other automation fingerprints
    // that TikTok (and most bot-detection systems) check for before serving real content
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // Process each keyword
    for (const keyword of config.keywords) {
      try {
        const results = await scrapeKeyword(page, keyword, existingUrls);
        allNew = allNew.concat(results);
        results.forEach(r => existingUrls.add(r.url));
        log('PROGRESS', `Total new so far: ${allNew.length}`);
      } catch (err) {
        logError('KEYWORD', `Skipping keyword "${keyword}" due to error`, err);
      }

      // Delay between keywords
      if (config.keywords.indexOf(keyword) < config.keywords.length - 1) {
        const delay = config.delays.betweenKeywords;
        log('DELAY', `Waiting before next keyword...`);
        await randomDelay(delay);
      }
    }

    await browser.close();
    log('BROWSER', 'Browser closed');

  } catch (err) {
    logError('BROWSER', 'Browser error', err);
    if (browser) await browser.close().catch(() => {});
  }

  // Write new results to Google Sheets (deduplication already applied during scraping)
  if (sheets) {
    try {
      await appendToSheet(sheets, allNew);
    } catch (err) {
      logError('SHEETS', 'Failed to write to sheet', err);
    }
  }

  log('DONE', `✅ Scraper finished. Found ${allNew.length} new results.`);
}

main().catch(err => {
  logError('FATAL', 'Scraper crashed', err);
  process.exit(1);
});
