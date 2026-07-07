const express = require('express');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const YT_KEY = process.env.YOUTUBE_API_KEY;
const SHEET_ID = process.env.FARMERSHARVEST_SHEET_ID;

// ── GOOGLE AUTH ──
function getGoogleAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const SHEET_NAME = 'Sheet1';
const SHEET_RANGE = `'${SHEET_NAME}'!A:I`;
// Columns: Platform | Creator | Title/Caption | Link | Views | Date Posted | Date Discovered | Usage Rights | Thumbnail
// Column I (Thumbnail) was added later — existing rows will have it blank and fall back
// to the placeholder in the UI. New harvest runs populate it. Column J is left as a
// buffer, K1 continues to store the cooldown timestamp exactly as before.

// ── ENSURE HEADERS EXIST ──
async function ensureHeaders(sheets) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!A1:I1` });
  const row = r.data.values?.[0];
  // Re-write the header row if it's missing entirely, or if it's stuck on the old 8-column
  // layout that doesn't yet have the Thumbnail column at position I.
  const needsWrite = !row || row.length === 0 || row[0] !== 'Platform' || row[8] !== 'Thumbnail';
  if (needsWrite) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Platform', 'Creator', 'Title/Caption', 'Link', 'Views', 'Date Posted', 'Date Discovered', 'Usage Rights', 'Thumbnail']] },
    });
  }
}

// ── GET ALL ROWS ──
app.get('/api/sheet-data', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureHeaders(sheets);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
    const rows = r.data.values || [];
    const data = rows.slice(1).map((row, i) => ({
      rowIndex: i + 2, // actual sheet row number (1-indexed + header)
      platform: row[0] || '',
      creator: row[1] || '',
      title: row[2] || '',
      url: row[3] || '',
      views: row[4] || '',
      date: row[5] || '',
      discoveredAt: row[6] || '',
      usageRights: row[7] === 'TRUE' || row[7] === 'Yes' || row[7] === true,
      thumb: row[8] || '', // Column I — empty string for legacy rows, real URL for post-migration rows
    }));
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Sheet read error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADD NEW ROWS (with deduplication by link) ──
app.post('/api/sheet-add', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureHeaders(sheets);

    const newItems = Array.isArray(req.body) ? req.body : [req.body];

    // Get existing links to dedupe
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!D:D` });
    const existingLinks = new Set((existing.data.values || []).map(r => r[0]));

    const rowsToAdd = newItems
      .filter(item => item.url && !existingLinks.has(item.url))
      .map(item => [
        item.platform || '',
        item.creator || '',
        item.title || '',
        item.url || '',
        item.views || '',
        item.date || '',
        new Date().toISOString().split('T')[0],
        'FALSE',
        item.thumb || '', // Column I — thumbnail URL when the scraper captured one
      ]);

    if (rowsToAdd.length === 0) {
      return res.json({ ok: true, added: 0, message: 'No new items — all already in sheet' });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rowsToAdd },
    });

    res.json({ ok: true, added: rowsToAdd.length });
  } catch (err) {
    console.error('Sheet add error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE USAGE RIGHTS FOR A ROW ──
app.post('/api/sheet-update-rights', async (req, res) => {
  try {
    const { rowIndex, usageRights } = req.body;
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!H${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[usageRights ? 'TRUE' : 'FALSE']] },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Sheet update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── APIFY MULTI-PLATFORM HARVEST ──
const APIFY_TOKEN = process.env.APIFY_TOKEN;
// Set to 0 while testing/tuning the search configuration so you can run repeatedly
// without waiting. Once results look good, set HARVEST_COOLDOWN_DAYS=7 in Render's
// environment variables (no code change needed) to re-enable the budget-safe limit.
const COOLDOWN_DAYS = parseInt(process.env.HARVEST_COOLDOWN_DAYS || '0');
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// Server-side cooldown tracking — stored in the sheet itself so it persists across
// server restarts and is shared across anyone using the app, not just one browser.
// We use a dedicated key-value row at the very bottom of a hidden helper range.
const LAST_RUN_CELL = `'${SHEET_NAME}'!K1`; // stores ISO timestamp of last successful harvest

async function getLastRunTime(sheets) {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: LAST_RUN_CELL });
    const val = r.data.values?.[0]?.[0];
    return val ? new Date(val).getTime() : 0;
  } catch (err) {
    console.error('Could not read last run time:', err.message);
    return 0; // if we can't read it, allow the run rather than blocking the user permanently
  }
}

async function setLastRunTime(sheets) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: LAST_RUN_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [[new Date().toISOString()]] },
  });
}

// Calls an Apify Actor synchronously and returns its dataset items.
// Has its own timeout since Apify runs can take a few minutes, and isolates
// failures so one platform's scraper failing doesn't crash the other two.
async function runApifyActor(actorId, input, label) {
  const url = `https://api.apify.com/v2/actors/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      timeout: 300000, // 5 min — matches Apify's own run-sync-get-dataset-items server-side limit;
                       // if Apify itself times out first, we still get back whatever's in the
                       // dataset at that point rather than our own connection dying first
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Apify returned ${r.status}: ${errText.slice(0, 300)}`);
    }
    const items = await r.json();
    console.log(`[${label}] Apify returned ${items.length} raw items`);
    return { ok: true, items };
  } catch (err) {
    console.error(`[${label}] Apify call failed:`, err.message);
    return { ok: false, items: [], error: err.message };
  }
}

// ── PARSERS — convert each platform's raw Apify output into our common row shape ──

function parseTikTokItems(items) {
  if (!Array.isArray(items)) {
    console.error('[TikTok] Expected an array of items but got:', typeof items);
    return [];
  }
  return items
    .filter(item => item && (item.webVideoUrl || item.videoUrl))
    .map(item => {
      // Defensive extraction — TikTok scraper field names can vary slightly between
      // versions, so we check several plausible field names rather than assuming one.
      let creator = 'Unknown';
      if (item.authorMeta?.name) creator = '@' + item.authorMeta.name;
      else if (item.authorMeta?.nickName) creator = item.authorMeta.nickName;
      else if (item.author?.uniqueId) creator = '@' + item.author.uniqueId;
      else if (item.authorUniqueId) creator = '@' + item.authorUniqueId;

      const views = item.playCount ?? item.diggCount ?? item.stats?.playCount ?? 0;
      const dateRaw = item.createTimeISO || item.createTime || '';
      const date = typeof dateRaw === 'string' && dateRaw.includes('T') ? dateRaw.split('T')[0] : '';

      // Thumbnail — TikTok scraper puts the video cover image under several possible
      // field names depending on scraper version. coverUrl is the primary/current one.
      const thumb =
        item.videoMeta?.coverUrl ||
        item.videoMeta?.originalCoverUrl ||
        item.covers?.[0] ||
        item.videoMeta?.dynamicCover ||
        '';

      return {
        platform: 'TikTok',
        creator,
        title: (item.text || item.desc || '').slice(0, 300),
        url: item.webVideoUrl || item.videoUrl,
        views: formatViews(views),
        date,
        thumb,
      };
    });
}

function parseInstagramItems(items) {
  if (!Array.isArray(items)) {
    console.error('[Instagram] Expected an array of items but got:', typeof items);
    return [];
  }
  return items
    .filter(item => item && item.url)
    .map(item => {
      let creator = 'Unknown';
      if (item.ownerUsername) creator = '@' + item.ownerUsername;
      else if (item.owner?.username) creator = '@' + item.owner.username;
      else if (item.username) creator = '@' + item.username;

      const views = item.videoViewCount ?? item.likesCount ?? item.likeCount ?? 0;
      const dateRaw = item.timestamp || item.takenAt || '';
      const date = typeof dateRaw === 'string' && dateRaw.includes('T') ? dateRaw.split('T')[0] : '';

      // Thumbnail — Instagram's Apify scraper returns displayUrl for posts/reels images,
      // thumbnailUrl for video posts, and sometimes an images[] array on carousels.
      // These URLs return 403 when hotlinked from a browser due to Instagram's referrer
      // check, so the frontend routes them through /api/img on our own server which strips
      // the referrer before fetching.
      const thumb =
        item.displayUrl ||
        item.thumbnailUrl ||
        (Array.isArray(item.images) && item.images[0]) ||
        '';

      return {
        platform: 'Instagram',
        creator,
        title: (item.caption || item.text || '').slice(0, 300),
        url: item.url,
        views: formatViews(views),
        date,
        thumb,
      };
    });
}

// Google Search results are generic SERP data (title, url, snippet) — we filter to
// only keep results actually pointing at facebook.com or instagram.com domains,
// since the search query itself can sometimes return unrelated indexed pages too.
// Defensive against multiple possible response shapes since we haven't seen a real sample yet.
function parseGoogleSearchItems(items) {
  if (!Array.isArray(items)) {
    console.error('[GoogleSearch] Expected an array of items but got:', typeof items);
    return [];
  }
  const rows = [];
  for (const item of items) {
    // The Google Search Scraper typically nests results per-query under organicResults,
    // but we check a couple of plausible alternate field names defensively.
    const organicResults = item.organicResults || item.results || item.serpResults || [];
    if (!Array.isArray(organicResults)) continue;

    for (const result of organicResults) {
      const link = result.url || result.link;
      if (!link || typeof link !== 'string') continue;
      const isFacebook = link.includes('facebook.com');
      const isInstagram = link.includes('instagram.com');
      if (!isFacebook && !isInstagram) continue;

      rows.push({
        platform: isFacebook ? 'Facebook' : 'Instagram',
        creator: extractHandleFromUrl(link) || (result.title || '').slice(0, 60) || 'Unknown',
        title: (result.description || result.snippet || result.title || '').slice(0, 300),
        url: link,
        views: '', // Google search doesn't expose view counts
        date: '', // Google search doesn't expose post dates reliably
        // Google Search results often don't include a thumbnail, but a few plausible
        // field names show up depending on the result type. If none are present the
        // sheet cell stays empty and the UI shows a placeholder — acceptable fallback.
        thumb: result.thumbnailImageUrl || result.image || result.imageUrl || '',
      });
    }
  }
  return rows;
}

function extractHandleFromUrl(url) {
  try {
    const match = url.match(/(?:facebook|instagram)\.com\/([^/?]+)/);
    return match ? '@' + match[1] : null;
  } catch (e) {
    return null;
  }
}

// ── RELEVANCE FILTER ──
// Simple keyword-based check to cut out content that matched our broad search terms
// coincidentally (e.g. news stories about farmers fighting bandits, bodybuilding videos)
// without needing an AI API call. Not perfect — genuine edge cases can still slip through
// either direction — but removes the most obvious noise we saw in the first real run.
const RELEVANT_PHRASES = [
  'farmers defense', 'farmersdefense', "farmer's defense", 'farmer\u2019s defense',
];
const PRODUCT_WORDS = [
  'sleeve', 'glove', 'sun hat', 'upf', 'gardening', 'garden', 'apron', 'hoodie',
  'snap back', 'leg sleeve',
];

function isLikelyRelevant(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Strong signal: the brand name itself (with or without space/apostrophe) appears
  if (RELEVANT_PHRASES.some(phrase => lower.includes(phrase))) return true;
  // Weaker signal: mentions a specific product word AND the word "defense" together —
  // catches creators tagging @farmersdefense without spelling out the full brand name
  // in the caption text itself
  if (lower.includes('defense') && PRODUCT_WORDS.some(w => lower.includes(w))) return true;
  return false;
}

function filterRelevant(rows, label) {
  const before = rows.length;
  const filtered = rows.filter(r => isLikelyRelevant(r.title) || isLikelyRelevant(r.creator));
  const removed = before - filtered.length;
  if (removed > 0) console.log(`[${label}] Relevance filter removed ${removed} of ${before} results`);
  return filtered;
}

// ── MAIN HARVEST ENDPOINT ──
// In-memory job tracker. We only ever run one harvest job at a time (enforced by the
// cooldown anyway), so a single module-level variable is sufficient — no database needed
// just to track "is a harvest currently running and what did it find."
let currentJob = null; // { status: 'running'|'done'|'error', startedAt, result, error }

app.post('/api/harvest-all', async (req, res) => {
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'Apify token not configured on server' });

  if (currentJob && currentJob.status === 'running') {
    return res.status(409).json({ error: 'A harvest is already running. Please wait for it to finish.' });
  }

  let auth, sheets;
  try {
    auth = getGoogleAuth();
    sheets = google.sheets({ version: 'v4', auth });
  } catch (err) {
    return res.status(500).json({ error: 'Could not connect to Google Sheets: ' + err.message });
  }

  // Enforce the 7-day cooldown server-side so it can't be bypassed by calling this
  // endpoint directly, and so it's consistent for every person using the app.
  const lastRun = await getLastRunTime(sheets);
  const elapsed = Date.now() - lastRun;
  if (lastRun > 0 && elapsed < COOLDOWN_MS) {
    const remainingMs = COOLDOWN_MS - elapsed;
    const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    return res.status(429).json({
      error: `Please wait ${remainingDays} more day${remainingDays !== 1 ? 's' : ''} before running another harvest.`,
      remainingDays,
    });
  }

  // Respond immediately — the actual scraping + sheet writing happens in the background.
  // This avoids the request sitting open for several minutes, which risks hitting
  // Render's (or any host's) platform-level HTTP timeout regardless of our own code.
  currentJob = { status: 'running', startedAt: Date.now(), result: null, error: null };
  res.json({ ok: true, message: 'Harvest started. Poll /api/harvest-job-status for progress.' });

  // Fire the actual work after responding — errors here are caught and stored on
  // currentJob rather than thrown, since there's no HTTP response left to send them to.
  runFullHarvest(sheets).then(result => {
    currentJob = { status: 'done', startedAt: currentJob.startedAt, result, error: null };
  }).catch(err => {
    console.error('Harvest job failed:', err);
    currentJob = { status: 'error', startedAt: currentJob.startedAt, result: null, error: err.message };
  });
});

// The actual harvest logic, extracted so it can run in the background after we've
// already responded to the triggering request above.
async function runFullHarvest(sheets) {
  const platformResults = {};
  const allRows = [];

  // Run all three platforms. Each is wrapped so a failure in one doesn't stop the others.
  const [tiktokRun, instagramRun, googleRun] = await Promise.all([
    runApifyActor('clockworks~tiktok-scraper', {
      // Widened the hashtag list to cast a broader net for genuinely different UGC.
      // TikTok's hashtag pages return roughly the same top-performing 200 posts each
      // run — that's why repeat runs on just 2 hashtags kept finding the same content.
      // Adding brand-adjacent product hashtags surfaces creators who tag their content
      // with what they're wearing/using rather than the brand name specifically.
      hashtags: [
        'farmersdefense',
        'farmersdefensegloves',
        'farmersdefensesleeves',
        'gardengloves',
        'gardeninggloves',
        'uvsleeves',
        'sunprotectionsleeves',
      ],
      resultsPerPage: 100,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,
      scrapeRelatedSearchWords: false,
      scrapeRelatedVideos: false,
      scrapeAdditionalAuthorMeta: false,
      commentsPerPost: 0,
      proxyCountryCode: 'None',
    }, 'TikTok'),

    runApifyActor('apify~instagram-scraper', {
      // BIG CHANGE — abandoning hashtag search entirely. Real Instagram UGC for this
      // brand lives at the account's *tagged* page, not under the #farmersdefense
      // hashtag (creators tag @farmersdefense, not the hashtag itself). The v13
      // hashtag fix worked mechanically but the source was dry — 1 result confirmed
      // both via API and via manual Apify web-UI runs. The tagged page is public and
      // scrapable via directUrls and returns actual creator UGC.
      //
      // We also keep the two hashtag URLs as a safety net in case any content does
      // start showing up there over time. All routed through directUrls to sidestep
      // the "saved form defaults get merged with API input" trap that bit us before.
      directUrls: [
        'https://www.instagram.com/farmersdefense/tagged/',
        'https://www.instagram.com/explore/tags/farmersdefense/',
        'https://www.instagram.com/explore/tags/farmersdefensegloves/',
      ],
      resultsType: 'posts',
      resultsLimit: 200,
      addParentData: false,
    }, 'Instagram'),

    runApifyActor('apify~google-search-scraper', {
      queries: 'site:facebook.com "farmers defense" reels\nsite:instagram.com "farmers defense"\nsite:facebook.com "farmersdefense"\nsite:instagram.com "farmersdefense"',
      maxPagesPerQuery: 2, // raised from 1 — more pages per query means more total
                           // links found; doubled the number of query variations too
      mobileResults: false,
      includeUnfilteredResults: false,
      forceExactMatch: false,
      saveHtml: false,
      saveHtmlToKeyValueStore: false,
    }, 'GoogleSearch(Facebook)'),
  ]);

  // TikTok
  platformResults.tiktok = { ok: tiktokRun.ok, error: tiktokRun.error, count: 0 };
  if (tiktokRun.ok) {
    const rawRows = parseTikTokItems(tiktokRun.items);
    const rows = filterRelevant(rawRows, 'TikTok');
    allRows.push(...rows);
    platformResults.tiktok.count = rows.length;
  }

  // Instagram
  platformResults.instagram = { ok: instagramRun.ok, error: instagramRun.error, count: 0 };
  if (instagramRun.ok) {
    const rawRows = parseInstagramItems(instagramRun.items);
    const rows = filterRelevant(rawRows, 'Instagram');
    allRows.push(...rows);
    platformResults.instagram.count = rows.length;
  }

  // Google Search (Facebook + bonus Instagram coverage) — search queries already require
  // "farmers defense" explicitly, so this is mostly a safety net rather than the primary filter
  platformResults.googleSearch = { ok: googleRun.ok, error: googleRun.error, count: 0 };
  if (googleRun.ok) {
    const rawRows = parseGoogleSearchItems(googleRun.items);
    const rows = filterRelevant(rawRows, 'GoogleSearch');
    allRows.push(...rows);
    platformResults.googleSearch.count = rows.length;
  }

  // Write everything to the sheet with deduplication by link, same logic as sheet-add
  let added = 0;
  let writeError = null;
  try {
    await ensureHeaders(sheets);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!D:D` });
    const existingLinks = new Set((existing.data.values || []).map(r => r[0]));

    const rowsToAdd = allRows
      .filter(item => item.url && !existingLinks.has(item.url))
      .map(item => [
        item.platform || '',
        item.creator || '',
        item.title || '',
        item.url || '',
        item.views || '',
        item.date || '',
        new Date().toISOString().split('T')[0],
        'FALSE',
        item.thumb || '', // Column I — thumbnail URL when the scraper captured one
      ]);

    const skipped = allRows.length - rowsToAdd.length;
    console.log(`[Sheet] After dedup: ${rowsToAdd.length} new rows to add, ${skipped} skipped as duplicates (of ${allRows.length} filtered rows total)`);

    if (rowsToAdd.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rowsToAdd },
      });
      console.log(`[Sheet] Successfully wrote ${rowsToAdd.length} new rows`);
    } else {
      console.log(`[Sheet] Nothing new to write — every URL in this run was already in the sheet`);
    }
    added = rowsToAdd.length;

    // Only mark the cooldown as started if we actually got through the write step —
    // if something failed before this point, we don't want to lock the user out
    // of retrying for 7 days over a transient error.
    await setLastRunTime(sheets);
  } catch (err) {
    console.error('Sheet write error during harvest:', err.message);
    writeError = err.message;
  }

  const anyPlatformSucceeded = platformResults.tiktok.ok || platformResults.instagram.ok || platformResults.googleSearch.ok;

  return {
    ok: anyPlatformSucceeded && !writeError,
    added,
    totalFound: allRows.length,
    platforms: platformResults,
    writeError,
  };
}

// Frontend polls this while a harvest is running to show live progress and final results
app.get('/api/harvest-job-status', (req, res) => {
  if (!currentJob) return res.json({ status: 'idle' });
  res.json(currentJob);
});

// Lets the frontend check cooldown status without triggering a harvest
app.get('/api/harvest-status', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const lastRun = await getLastRunTime(sheets);
    const elapsed = Date.now() - lastRun;
    const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);
    res.json({
      ok: true,
      lastRun: lastRun > 0 ? new Date(lastRun).toISOString() : null,
      canRunNow: remainingMs === 0,
      remainingDays: Math.ceil(remainingMs / (24 * 60 * 60 * 1000)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TikTok oEmbed — fetches official embed HTML + thumbnail for a TikTok video URL
app.get('/api/tiktok-embed', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const r = await fetch(oembedUrl);
    if (!r.ok) throw new Error('TikTok oEmbed request failed');
    const data = await r.json();
    res.json({ ok: true, html: data.html, thumbnail: data.thumbnail_url, title: data.title, author: data.author_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image proxy — strips the browser's Referer header when fetching a thumbnail so that
// Instagram (and occasionally TikTok) CDN URLs don't 403 the request. The frontend
// routes all sheet-backed thumbnail URLs through this endpoint. Whitelisted to the
// handful of CDN hosts we actually use so the endpoint can't be turned into an
// open proxy for arbitrary URLs.
const ALLOWED_IMG_HOSTS = [
  'cdninstagram.com', 'fbcdn.net',       // Instagram/Facebook CDNs
  'tiktokcdn.com', 'tiktokcdn-us.com',   // TikTok CDNs
  'googleusercontent.com',                // Google Search snippet images
  'gstatic.com',                          // Google image thumbnails
];
app.get('/api/img', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).send('Invalid url');
  }
  const hostOk = ALLOWED_IMG_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  if (!hostOk) return res.status(403).send('Host not allowed');

  try {
    const upstream = await fetch(url, {
      // Deliberately no Referer — that's the whole point of the proxy.
      // A generic browser UA reduces the chance of getting served a "bot" placeholder.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000,
    });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream error');
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    // Cache aggressively on the client — thumbnail URLs are effectively immutable
    // (they contain signed tokens/hashes), so we can safely cache for a day.
    res.set('Cache-Control', 'public, max-age=86400');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Image proxy error:', err.message);
    res.status(502).send('Proxy fetch failed');
  }
});

// YouTube search
app.get('/api/search', async (req, res) => {
  const { query, maxResults = 12, order = 'relevance', publishedAfter, publishedBefore } = req.query;
  if (!query) return res.status(400).json({ error: 'Query required' });
  try {
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${maxResults}&order=${order}&key=${YT_KEY}`;
    if (publishedAfter) url += `&publishedAfter=${publishedAfter}T00:00:00Z`;
    if (publishedBefore) url += `&publishedBefore=${publishedBefore}T23:59:59Z`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const ids = data.items.map(i => i.id.videoId).join(',');
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${YT_KEY}`;
    const statsRes = await fetch(statsUrl);
    const statsData = await statsRes.json();
    const statsMap = {};
    (statsData.items || []).forEach(v => { statsMap[v.id] = v; });
    const results = data.items.map(item => {
      const vid = item.id.videoId;
      const stats = statsMap[vid] || {};
      const views = parseInt(stats.statistics?.viewCount || 0);
      const duration = stats.contentDetails?.duration || '';
      const isShort = duration && parseDuration(duration) <= 60;
      return {
        id: vid,
        title: item.snippet.title,
        creator: item.snippet.channelTitle,
        date: item.snippet.publishedAt?.split('T')[0],
        thumb: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
        views: formatViews(views),
        viewsNum: views,
        platform: 'yt',
        type: isShort ? 'short' : 'video',
        ytId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
    });
    res.json({ ok: true, results, total: results.length });
  } catch (err) {
    console.error('YouTube error:', err);
    res.status(500).json({ error: err.message });
  }
});

function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 999;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

function formatViews(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌱 Farmers Defense Content running on port ${PORT}`));
