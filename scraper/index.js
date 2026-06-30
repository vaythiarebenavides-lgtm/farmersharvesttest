const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
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

// ── LOAD EXISTING RESULTS ──
function loadExisting() {
  try {
    const filePath = path.resolve(config.resultsFile);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      log('STORAGE', `Loaded ${data.length} existing results`);
      return data;
    }
  } catch (err) {
    logError('STORAGE', 'Could not load existing results', err);
  }
  return [];
}

// ── SAVE RESULTS ──
function saveResults(results) {
  try {
    const filePath = path.resolve(config.resultsFile);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
    log('STORAGE', `Saved ${results.length} total results to ${filePath}`);
  } catch (err) {
    logError('STORAGE', 'Could not save results', err);
  }
}

// ── SAVE SCREENSHOT ON ERROR ──
async function saveErrorScreenshot(page, keyword, stage) {
  try {
    const dir = path.resolve('./error-screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `error-${stage}-${keyword.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`;
    await page.screenshot({ path: `${dir}/${filename}.png` });
    fs.writeFileSync(`${dir}/${filename}.html`, await page.content());
    log('DEBUG', `Saved error screenshot: ${filename}`);
  } catch (e) {
    logError('DEBUG', 'Could not save error screenshot', e);
  }
}

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
    await randomDelay(config.delays.pageLoad);

    // Check if page loaded
    const title = await page.title();
    log('NAVIGATE', `Page title: ${title}`);

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
      logError('PARSE', 'Primary selector failed, trying fallbacks', err);
      // Try fallback selectors
      for (const fallback of config.fallbackSelectors.videoLinks) {
        try {
          links = await page.$$eval(fallback, els =>
            els.map(el => ({ url: el.href, text: el.textContent?.trim() || '' }))
               .filter(l => l.url && l.url.includes('tiktok.com'))
          );
          if (links.length > 0) {
            log('PARSE', `Fallback selector "${fallback}" found ${links.length} links`);
            break;
          }
        } catch (e) {}
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
        creator: username,
        caption: link.text || keyword + ' content',
        date: new Date().toISOString().split('T')[0],
        views: 'N/A',
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

  const existing = loadExisting();
  const existingUrls = new Set(existing.map(r => r.url));
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
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
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

  // Save combined results
  const combined = [...existing, ...allNew];
  saveResults(combined);

  log('DONE', `✅ Scraper finished. Found ${allNew.length} new results. Total: ${combined.length}`);
}

main().catch(err => {
  logError('FATAL', 'Scraper crashed', err);
  process.exit(1);
});
