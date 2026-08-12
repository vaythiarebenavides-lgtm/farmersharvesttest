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

// ── THUMBNAIL PERSISTENCE ──────────────────────────────────────────────────
// The problem: Instagram/Facebook/TikTok CDN URLs are signed to expire within
// hours-to-days. Even TikTok oEmbed URLs (which we used to trust) have an
// x-expires querystring that ages out ~2 days after fetch. This means every
// stored thumbnail eventually 404s and the grid goes blank.
//
// The fix: fetch the CDN URL once, resize + compress the image with sharp so
// the base64-encoded bytes comfortably fit inside a Google Sheets cell
// (50,000 char limit), and store the base64 data URL directly in the sheet.
// <img src="data:image/jpeg;base64,..."> renders natively in every browser
// with zero external hosting, zero cost, and no expiration ever possible.
//
// Sharp is required because raw CDN thumbnails are often 40-150KB (base64 =
// ~53-200KB, which exceeds the cell limit for the larger ones). Resizing to
// max 400x400 at quality 65 typically produces ~10-25KB output, base64ed to
// ~13-33KB — comfortably under the limit with headroom.

const sharp = require('sharp');

// Fetch a CDN image URL, downscale and recompress it, and return a base64
// data URL suitable for both <img src=""> and Sheets cell storage. Returns
// null on any failure (network error, sharp decode error, resulting bytes
// still too big for a cell) so the caller can fall back gracefully.
async function fetchAndEncodeThumb(imageUrl) {
  try {
    // Some IG/FB URLs 403 without a real-browser UA. Use one that matches
    // what our other fetches use so we don't get blocked differently here.
    const imgRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'image/webp,image/*,*/*;q=0.8',
      },
    });
    if (!imgRes.ok) return null;
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.length === 0) return null;

    // Resize to fit within a 400x400 box (aspect preserved), reencode as jpeg
    // quality 65. This gives a good tradeoff between file size and visual
    // quality in the ~200px-wide grid cards. The .rotate() applies any EXIF
    // orientation so IG portraits don't come out sideways. Wrapped in try/catch
    // because sharp will throw on unrecognized input (e.g. corrupt bytes).
    let jpegBytes;
    try {
      jpegBytes = await sharp(buffer)
        .rotate()
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 65, mozjpeg: true })
        .toBuffer();
    } catch (sharpErr) {
      console.error('sharp resize failed:', sharpErr.message);
      return null;
    }

    const base64 = jpegBytes.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    // Google Sheets cell limit is 50,000 chars. Skip anything over 49,000
    // to leave a safety margin. Extremely unusual with our resize settings —
    // 400x400 quality 65 typically produces ~10-25KB base64 output — but if
    // an image is exceptionally complex/detailed and still ends up too big,
    // we return null and let it stay as a placeholder rather than write an
    // invalid oversized value.
    if (dataUrl.length > 49000) {
      console.error(`Thumbnail too large after compression: ${dataUrl.length} chars`);
      return null;
    }
    return dataUrl;
  } catch (e) {
    console.error('fetchAndEncodeThumb failed:', e.message);
    return null;
  }
}

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

    const toAdd = newItems.filter(item => item.url && !existingLinks.has(item.url));

    // Encode thumbnails to base64 before writing — see the detailed comment on
    // the same logic in /api/harvest-all. Short version: scraper-supplied CDN
    // URLs expire within days, so we bake the image into the sheet instead.
    const CONCURRENCY = 5;
    for (let i = 0; i < toAdd.length; i += CONCURRENCY) {
      const slice = toAdd.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (item) => {
        if (!item.thumb || item.thumb.startsWith('data:image/')) return;
        const dataUrl = await fetchAndEncodeThumb(item.thumb);
        item.thumb = dataUrl || '';
      }));
    }

    const rowsToAdd = toAdd.map(item => [
      item.platform || '',
      item.creator || '',
      item.title || '',
      item.url || '',
      item.views || '',
      item.date || '',
      new Date().toISOString().split('T')[0],
      'FALSE',
      item.thumb || '', // Column I — base64 data URL, permanent, set above
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

// Delete a single sheet row (user clicked the red X on a card in the app) AND add
// its URL to a blocklist so future harvests don't re-add it. Blocklist lives in
// column L with a header at L1 — this keeps it out of the way of the main data
// (cols A-I) and the cooldown timestamp (K1). The main harvest write-step reads
// L2:L into its dedup Set so blocked URLs are treated the same as already-present ones.
app.post('/api/sheet-delete-row', async (req, res) => {
  try {
    const { rowIndex, url } = req.body;
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Deleting a row (as opposed to clearing its values) requires the numeric sheet ID,
    // not the spreadsheet ID — those are different things. Look it up from the metadata.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
    if (!sheet) return res.status(500).json({ error: `Tab "${SHEET_NAME}" not found` });
    const sheetId = sheet.properties.sheetId;

    // Delete the row. Google's dimension API uses 0-based indexes half-open [start, end),
    // whereas the rowIndex from the frontend is 1-based. So sheet row 5 → startIndex 4, endIndex 5.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        }],
      },
    });

    // Add URL to the blocklist so it doesn't get re-added by the next harvest.
    // Ensure header at L1 first (idempotent) so appends land at L2 onwards.
    if (url) {
      const headerCheck = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!L1` });
      if (!headerCheck.data.values || headerCheck.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `'${SHEET_NAME}'!L1`,
          valueInputOption: 'RAW',
          requestBody: { values: [['Blocked URLs (auto)']] },
        });
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_NAME}'!L:L`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[url]] },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Sheet delete error:', err);
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
        // Diagnostic only — see note in parseInstagramItems. Not written to the sheet.
        _raw: item,
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
        // Kept only for the harvest-time thumbnail diagnostic; never written to
        // the sheet. Lets us log the real Apify field names when thumb comes back
        // empty, instead of guessing which key holds the image.
        _raw: item,
      };
    });
}

// Parser for scrapeforge~facebook-search-posts. This Actor does real keyword search
// against Facebook (unlike the Google Search workaround, which only finds links via
// SERP data and gets no images, dates, or engagement numbers).
//
// IMPORTANT: this Actor returns items in TWO DIFFERENT SHAPES, confirmed from real
// runs. Some items arrive flattened, with literal dots in the property names —
// `item["image.uri"]`, `item["author.name"]`. Others arrive with proper nested
// objects — `item.image.uri`, `item.author.name`. Reading only one shape silently
// misses roughly half the images, so every field below checks both.
//
// Image can also live under `video_thumbnail` (video posts) or `album_preview`
// (multi-photo posts), neither of which appeared in the first sample. Checking all
// four sources materially improves the hit rate over `image` alone.
function parseFacebookSearchItems(items) {
  if (!Array.isArray(items)) {
    console.error('[Facebook] Expected an array of items but got:', typeof items);
    return [];
  }
  return items
    .filter(item => item && item.url)
    .map(item => {
      // Author: flattened key first, then nested object, then the `authors` array
      // some items carry instead, then finally fall back to deriving from the URL.
      const authorName =
        item['author.name'] ||
        item.author?.name ||
        (Array.isArray(item.authors) && item.authors[0]?.name) ||
        '';
      const authorUrl = item['author.url'] || item.author?.url || '';
      const creator = authorName
        || extractCreator(authorUrl || item.url, item.message)
        || 'Unknown';

      // Facebook has no plain "view count" for image posts, but video posts do expose
      // video_view_count. Prefer that when present since it's directly comparable to
      // TikTok/Instagram view numbers; otherwise fall back to reactions, which is the
      // closest analogue to likes. Keeps the "Most popular" sort meaningful.
      const views = item.video_view_count ?? item.reactions_count ?? 0;

      // timestamp is Unix seconds. Guard against it arriving as a string or as
      // already-formatted ISO from a future Actor version.
      let date = '';
      if (typeof item.timestamp === 'number' && item.timestamp > 0) {
        date = new Date(item.timestamp * 1000).toISOString().split('T')[0];
      } else if (typeof item.timestamp === 'string' && item.timestamp.includes('T')) {
        date = item.timestamp.split('T')[0];
      }

      // Image extraction. The Actor has already surprised us twice — flattened vs
      // nested shapes, and image data appearing under video_thumbnail/album_preview —
      // so rather than enumerate every possible path, try the known ones first and
      // then fall back to a bounded recursive search for any string that looks like
      // an image URL. This is deliberately permissive: a wrong-but-valid image is far
      // better than a blank card, and non-image URLs are filtered out by the check.
      const albumPreview = Array.isArray(item.album_preview) ? item.album_preview[0] : item.album_preview;
      const looksLikeImageUrl = (s) =>
        typeof s === 'string' &&
        /^https?:\/\//.test(s) &&
        (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(s) || /fbcdn|cdninstagram|scontent/i.test(s));

      // Bounded depth-first search for the first image-looking URL inside a value.
      // Depth-capped so a deeply nested or cyclic structure can't hang the harvest.
      const findImageUrl = (val, depth = 0) => {
        if (depth > 4 || val == null) return '';
        if (typeof val === 'string') return looksLikeImageUrl(val) ? val : '';
        if (Array.isArray(val)) {
          for (const v of val) {
            const found = findImageUrl(v, depth + 1);
            if (found) return found;
          }
          return '';
        }
        if (typeof val === 'object') {
          // Prefer conventional URL-ish keys before scanning everything else.
          for (const k of ['uri', 'url', 'src', 'image', 'thumbnail']) {
            if (val[k]) {
              const found = findImageUrl(val[k], depth + 1);
              if (found) return found;
            }
          }
          for (const v of Object.values(val)) {
            const found = findImageUrl(v, depth + 1);
            if (found) return found;
          }
        }
        return '';
      };

      const thumb =
        item['image.uri'] ||                    // flattened single image
        findImageUrl(item.image) ||             // nested single image, any shape
        findImageUrl(item.video_thumbnail) ||   // video post cover
        findImageUrl(albumPreview) ||           // multi-photo post, first image
        findImageUrl(item.video_files) ||       // video posts sometimes carry a poster here
        '';

      return {
        platform: 'Facebook',
        creator,
        title: (item.message || '').slice(0, 300),
        url: item.url,
        views: formatViews(views),
        date,
        thumb,
        // Diagnostic only — see note in parseInstagramItems. Not written to the sheet.
        _raw: item,
      };
    });
}


// only keep results actually pointing at facebook.com or instagram.com domains,
// since the search query itself can sometimes return unrelated indexed pages too.
// Defensive against multiple possible response shapes since we haven't seen a real sample yet.
// UNUSED as of the Facebook search Actor migration — kept for reference only.
// The apify~google-search-scraper run that fed this parser was removed because its
// SERP-derived rows had no image, date, or engagement data. If that Actor is ever
// reinstated, this parser still works; otherwise it can be deleted safely.
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
        creator: extractCreator(link, result.title) || 'Unknown',
        title: (result.description || result.snippet || result.title || '').slice(0, 300),
        url: link,
        views: '', // Google search doesn't expose view counts
        date: '', // Google search doesn't expose post dates reliably
        // Google Search results often don't include a thumbnail, but a few plausible
        // field names show up depending on the result type. If none are present the
        // sheet cell stays empty and the UI shows a placeholder — acceptable fallback.
        thumb: result.thumbnailImageUrl || result.image || result.imageUrl || '',
        // Diagnostic only — see note in parseInstagramItems. Not written to the sheet.
        _raw: result,
      });
    }
  }
  return rows;
}

// URL path segments that look like usernames but aren't — they're URL type/section
// markers (e.g. instagram.com/p/POSTID means "p" is the type "post", not a creator).
// The old extractHandleFromUrl blindly took the first segment as the creator, which
// polluted the sheet with fake handles like @p, @reel, @groups, @marketplace. This
// list is the union of Instagram + Facebook URL section names so we can reject them
// during creator extraction.
const RESERVED_URL_SEGMENTS = new Set([
  // Instagram URL sections
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 's',
  // Facebook URL sections
  'watch', 'groups', 'marketplace', 'pages', 'events', 'pg', 'permalink.php',
  'share', 'story.php', 'video.php', 'photo.php', 'media', 'posts', 'videos',
  'photos', 'plugins', 'help', 'business', 'search', 'hashtag', 'gaming',
  'notes', 'donate', 'fundraisers', 'saved', 'lite', 'l.php', 'ads', 'login',
  'signup', 'privacy', 'policies', 'terms', 'settings', 'about', 'careers',
]);

// Attempt to derive a real creator handle from a Facebook or Instagram URL,
// falling back to a title-based lookup if the URL's first path segment is one
// of the reserved section keywords above. Returns "@handle" or null (caller
// decides whether to use "Unknown" or leave the field alone).
function extractCreator(url, title) {
  try {
    const match = url.match(/(?:facebook|instagram)\.com\/([^/?#]+)/i);
    if (match) {
      const seg = match[1];
      const lower = seg.toLowerCase();
      // If the first segment isn't a URL type marker, treat it as the creator
      if (!RESERVED_URL_SEGMENTS.has(lower) && !lower.endsWith('.php') && seg.length > 0) {
        return '@' + seg;
      }
    }
  } catch {}

  // Title fallback — Instagram Google-search results usually look like
  //   "Kalika Bastola (@kalikabastola) on Instagram: ..."
  // Extract the (@handle) if present. Facebook titles rarely include handles,
  // so this mostly helps Instagram — that's fine, IG is the bigger offender.
  if (title) {
    const m = title.match(/\(@([a-z0-9._]+)\)/i);
    if (m) return '@' + m[1];
  }

  return null;
}

// ── RELEVANCE FILTER ──
// Two-layer check on each scraped item's text before we save it to the sheet:
//   1. Whitelist: must contain "farmers defense" (in some form) OR "defense" + a product word
//   2. Noise blacklist: must NOT contain any known-unrelated phrase (football, disaster, etc.)
// Without the noise layer, posts that use a Farmers Defense hashtag AND happen to be about
// unrelated topics (football clips, flood victim news, cinema reviews) still slip through.
// Not perfect — genuine edge cases can still slip either direction — but removes the most
// obvious noise the whitelist alone lets through.
const RELEVANT_PHRASES = [
  'farmers defense', 'farmersdefense', "farmer's defense", 'farmer\u2019s defense',
];
const PRODUCT_WORDS = [
  'sleeve', 'glove', 'sun hat', 'upf', 'gardening', 'garden', 'apron', 'hoodie',
  'snap back', 'leg sleeve',
];

// Whole-word blocklist of topics that are clearly not Farmers Defense UGC. Uses \b
// word boundaries so "fire" doesn't match "firefly" or "campfire", "war" doesn't
// match "warm" or "warrior", etc. Add/remove entries here as new noise patterns show up.
const NOISE_PHRASES = [
  // Sports (unrelated to gardening/UV brand)
  'football', 'nfl', 'nba', 'basketball', 'soccer', 'baseball',
  // Fitness/other lifestyle content that keeps hijacking product hashtags
  'bodybuilding', 'gym workout',
  // Crypto/finance grifter content
  'crypto', 'bitcoin', 'nft',
  // News/disaster/violence — surfaces via "defense" or "farmer" keywords
  'bandit', 'flood', 'disaster', 'fire', 'victim', 'killed', 'died', 'funeral',
  'arrested', 'police', 'shooting', 'war', 'homicide', 'murder',
  // Politics
  'politics', 'election', 'president', 'senator',
  // Country/region false positives we've seen in real runs
  'nigeria', 'gomoa',
  // Farm-adjacent but not gardening product content
  'manure',
  // Entertainment noise
  'cinema', 'movie review', 'gaming', 'twitch',
];
const NOISE_REGEX = new RegExp('\\b(' + NOISE_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');

function isLikelyRelevant(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Strong signal: the brand name itself (with or without space/apostrophe) appears
  if (RELEVANT_PHRASES.some(phrase => lower.includes(phrase))) return true;
  // Weaker signal: mentions a specific product word AND the word "defense" together —
  // catches creators tagging @farmersdefense without spelling out the full brand name
  if (lower.includes('defense') && PRODUCT_WORDS.some(w => lower.includes(w))) return true;
  return false;
}

function hasNoisePhrase(text) {
  if (!text) return false;
  return NOISE_REGEX.test(text);
}

function filterRelevant(rows, label) {
  const before = rows.length;
  let filteredForNoise = 0;
  const filtered = rows.filter(r => {
    const relevant = isLikelyRelevant(r.title) || isLikelyRelevant(r.creator);
    if (!relevant) return false;
    if (hasNoisePhrase(r.title) || hasNoisePhrase(r.creator)) {
      filteredForNoise++;
      return false;
    }
    return true;
  });
  const removed = before - filtered.length;
  if (removed > 0) console.log(`[${label}] Filter removed ${removed} of ${before} (${filteredForNoise} for noise phrases)`);
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
  // Query terms for the Facebook search Actor. Each one costs a separate Actor run,
  // so keep the list tight. All results still pass through filterRelevant afterwards,
  // which requires the brand name (or "defense" + a product word) in the caption or
  // author name — so a broad query like "farmers defense" can't drag in rubbish.
  const FACEBOOK_SEARCH_QUERIES = [
    'farmers defense',
    'farmers defense sleeves',
    'farmersdefense',
  ];

  const [tiktokRun, instagramRun, ...facebookRuns] = await Promise.all([
    runApifyActor('clockworks~tiktok-scraper', {
      // Only using verified brand-specific and product-specific hashtags. Generic ones
      // like #sleeves, #farmer, #uvprotection, #sunprotection, #testimonial, #gardeninggear
      // return mostly unrelated content that our relevance filter then throws away —
      // we'd be paying Apify to scrape noise. Sticking to hashtags where signal is high.
      hashtags: [
        // Brand-specific — always high signal
        'farmersdefense',
        'farmersdefensegloves',
        'farmersdefensesleeves',
        'farmersdefensehat',
        // Product-specific — narrower than the generic alternatives (verified from real posts)
        'protectionsleeves',
        'gardensleeves',
      ],
      // Brand's own profile — surfaces official posts and often reposts of UGC creators
      profiles: ['farmersdefense'],
      // Search feed — completely different discovery path than hashtag pages, finds
      // videos where creators mention "farmers defense" in captions but didn't hashtag it.
      // This is where the actual UGC growth happens between runs.
      searchQueries: ['farmers defense', 'farmersdefense gloves'],
      // 30 per input × 9 total inputs ≈ 270 items max, ~$0.80/run cap
      resultsPerPage: 30,
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
      // Real Instagram UGC lives at the account's tagged page — creators tag
      // @farmersdefense in posts, they don't use #farmersdefense hashtag much.
      // Tagged page is the goldmine; hashtag URLs are belt-and-braces backup that
      // costs almost nothing since they typically return 0-2 posts each.
      // Only verified brand + safe product hashtags — no generics that would just
      // drag in noise that the relevance filter would throw away anyway.
      directUrls: [
        'https://www.instagram.com/farmersdefense/tagged/',      // UGC goldmine
        'https://www.instagram.com/explore/tags/farmersdefense/',
        'https://www.instagram.com/explore/tags/farmersdefensegloves/',
        'https://www.instagram.com/explore/tags/farmersdefensesleeves/',
        'https://www.instagram.com/explore/tags/farmersdefensehat/',
        'https://www.instagram.com/explore/tags/protectionsleeves/',
        'https://www.instagram.com/explore/tags/gardensleeves/',
      ],
      resultsType: 'posts',
      resultsLimit: 100,
      addParentData: false,
    }, 'Instagram'),

    // NOTE: apify~google-search-scraper was removed here. It existed as a Facebook
    // workaround back when there was no scrapable Facebook search — it found post
    // URLs via Google SERP data. But SERP results carry no image, no post date, and
    // no engagement numbers, so every row it produced landed in the sheet as a blank
    // card (~104 rows per harvest at its peak, the single largest source of missing
    // thumbnails). scrapeforge~facebook-search-posts below now covers Facebook
    // properly with images, timestamps, reaction/view counts and real author names,
    // making the Google path redundant as well as costly.
    //
    // Real Facebook keyword search via scrapeforge~facebook-search-posts.
    // This Actor takes ONE query per run, so we fire three in parallel to cover the
    // main brand-name variations. At $2.59/1000 results and 40 results each, the
    // whole set costs roughly $0.31 per harvest.
    ...FACEBOOK_SEARCH_QUERIES.map(q =>
      runApifyActor('scrapeforge~facebook-search-posts', {
        // Parameter names are snake_case — confirmed by reading the Actor's own
        // input JSON in the Apify console. camelCase equivalents are silently
        // ignored, so do not "tidy" these to match the style of the other Actors.
        query: q,
        search_type: 'posts',
        max_results: 40,
        recent_posts: true,
      }, `Facebook(${q})`)
    ),
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

  // Facebook keyword search — one Actor run per query, results merged. These rows
  // carry real dates, engagement counts, author names, and (for most posts) an image
  // URL that gets base64-encoded downstream. Every row still goes through
  // filterRelevant so unrelated posts that merely match the search string get dropped
  // before they reach the sheet.
  const facebookOk = facebookRuns.some(r => r.ok);
  const facebookError = facebookRuns.find(r => !r.ok)?.error || null;
  platformResults.facebook = { ok: facebookOk, error: facebookError, count: 0 };
  let facebookTotal = 0;
  for (const run of facebookRuns) {
    if (!run.ok) continue;
    const rawRows = parseFacebookSearchItems(run.items);
    const rows = filterRelevant(rawRows, 'Facebook');
    allRows.push(...rows);
    facebookTotal += rows.length;
  }
  platformResults.facebook.count = facebookTotal;

  // Write everything to the sheet with deduplication by link, same logic as sheet-add
  let added = 0;
  let writeError = null;
  try {
    await ensureHeaders(sheets);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!D:D` });
    const existingLinks = new Set((existing.data.values || []).map(r => r[0]));

    // Merge in the blocklist from column L (populated when users click the red X on
    // a card). Treat blocked URLs the same as already-present URLs — they get filtered
    // out before write, so a deleted post can't be re-added by a future harvest. If
    // the blocklist read fails for any reason we just fall back to regular dedup.
    try {
      const blocklist = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_NAME}'!L2:L` });
      const blockedRows = blocklist.data.values || [];
      blockedRows.forEach(row => { if (row[0]) existingLinks.add(row[0]); });
      if (blockedRows.length > 0) console.log(`[Sheet] Blocklist has ${blockedRows.length} URLs merged into dedup set`);
    } catch (blockErr) {
      console.error('[Sheet] Could not read blocklist (non-fatal):', blockErr.message);
    }

    const newItems = allRows.filter(item => item.url && !existingLinks.has(item.url));

    // Encode thumbnails to base64 at harvest time. The Apify scrapers already
    // hand us a working CDN image URL for most Instagram/Facebook/TikTok posts
    // (displayUrl / thumbnailUrl / images[0] / coverUrl), but those URLs are
    // signed and expire within a couple of days. Encoding them right now — while
    // the URL is still fresh and we're already doing network work — means the
    // thumbnail is permanent from the moment the row lands in the sheet, and
    // nobody ever has to run the backfill for newly harvested content.
    //
    // This is the fix for the "Instagram and Facebook thumbnails never fill in"
    // problem: the backfill can't get them because scraping IG/FB HTML server-side
    // hits a login wall, but Apify (running a real browser) already got past that
    // during the harvest. We just have to not throw the URL away.
    //
    // Runs with limited concurrency so a large harvest doesn't stall on serial
    // image downloads or hammer the CDNs. Failures degrade gracefully — the row
    // still gets written, just with an empty thumbnail cell that a later backfill
    // run can retry.
    const CONCURRENCY = 5;
    let encodedCount = 0;
    let encodeFailCount = 0;
    let noUrlCount = 0;
    // Tally missing-image rows per platform. Without this the aggregate count is
    // ambiguous — a high number could mean the Facebook parser is missing a field,
    // or simply that Google Search rows (which never carry images) dominate the
    // batch. The breakdown distinguishes a fixable bug from a known limitation.
    const noUrlByPlatform = {};

    // Diagnostic: for each platform, if any item arrived without a thumbnail URL,
    // log the actual field names Apify gave us on the first such item. Guessing at
    // scraper field names from memory has burned us before — this makes the real
    // response shape visible in the logs so a missing field can be fixed with
    // certainty instead of trial and error. Only logs one sample per platform per
    // run so it doesn't flood the log on a large harvest.
    const diagnosedPlatforms = new Set();
    for (const item of newItems) {
      if (item.thumb) continue;
      const platform = item.platform || 'Unknown';
      if (diagnosedPlatforms.has(platform)) continue;
      diagnosedPlatforms.add(platform);
      const raw = item._raw || null;
      if (raw && typeof raw === 'object') {
        // Print the actual VALUES of any image-like keys, not just their names.
        // Key names alone proved insufficient: an item can have an `image` key that
        // holds null, or a nested object keyed `url` rather than `uri`, and the name
        // list looks identical in both cases. Values are truncated to keep the log
        // readable while still showing the shape.
        const imageish = Object.keys(raw).filter(k => /image|thumb|display|cover|photo|media|pic|preview/i.test(k));
        const shapes = {};
        for (const k of imageish) {
          let v = raw[k];
          if (v === null || v === undefined) { shapes[k] = String(v); continue; }
          if (typeof v === 'string') { shapes[k] = 'string: ' + v.slice(0, 80); continue; }
          try {
            shapes[k] = JSON.stringify(v).slice(0, 220);
          } catch { shapes[k] = '(unserializable ' + typeof v + ')'; }
        }
        console.log(`[Thumbs][diag] ${platform}: no thumb. image-key VALUES = ${JSON.stringify(shapes)}`);
      } else {
        console.log(`[Thumbs][diag] ${platform}: no thumb and no raw item captured for inspection`);
      }
    }

    for (let i = 0; i < newItems.length; i += CONCURRENCY) {
      const slice = newItems.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (item) => {
        if (!item.thumb) {
          noUrlCount++;
          const p = item.platform || 'Unknown';
          noUrlByPlatform[p] = (noUrlByPlatform[p] || 0) + 1;
          return; // scraper gave us nothing to work with
        }
        // Already a data URL (shouldn't happen from a scraper, but be safe)
        if (item.thumb.startsWith('data:image/')) return;
        const dataUrl = await fetchAndEncodeThumb(item.thumb);
        if (dataUrl) {
          item.thumb = dataUrl;
          encodedCount++;
        } else {
          // Encoding failed — drop the ephemeral CDN URL rather than storing a
          // link that's going to 404 in 48 hours and look broken in the grid.
          item.thumb = '';
          encodeFailCount++;
        }
      }));
    }
    console.log(`[Thumbs] Encoded ${encodedCount}, encode-failed ${encodeFailCount}, no-url-from-scraper ${noUrlCount} (of ${newItems.length} new rows)`);
    if (noUrlCount > 0) {
      console.log(`[Thumbs] Missing images by platform: ${JSON.stringify(noUrlByPlatform)}`);
    }

    const rowsToAdd = newItems.map(item => [
      item.platform || '',
      item.creator || '',
      item.title || '',
      item.url || '',
      item.views || '',
      item.date || '',
      new Date().toISOString().split('T')[0],
      'FALSE',
      item.thumb || '', // Column I — base64 data URL, permanent, set above
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

  const anyPlatformSucceeded = platformResults.tiktok.ok || platformResults.instagram.ok || platformResults.facebook.ok;

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

// One-time backfill for rows that were harvested BEFORE the thumbnail column existed.
// Handles all three platforms:
//   - TikTok:    hits TikTok's public oEmbed endpoint (free, reliable)
//   - Instagram: fetches the post URL with a Facebook-crawler User-Agent and extracts
//                the og:image meta tag (free, works because IG serves OpenGraph preview
//                images to link-preview bots for Slack/Twitter/etc)
//   - Facebook:  same og:image approach as Instagram; occasionally hits a login wall and
//                returns nothing for that URL, in which case that row stays as placeholder
// Best-effort throughout — a URL that doesn't return anything just gets skipped, no crash.
// Processed in batches of BATCH_CAP so the HTTP request completes within Render's ~100s
// platform timeout — if more rows remain, the user clicks the button again to continue.
app.post('/api/backfill-thumbs', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureHeaders(sheets); // make sure column I header exists before writing to it

    // ?force=true → refresh every row's thumbnail, including ones that already
    // have a URL. Needed because IG/FB/TikTok CDN URLs saved before the base64
    // persistence went live are all expiring. Default false so normal daily
    // runs stay fast and only backfill genuinely-missing rows.
    const force = req.query.force === 'true' || req.body?.force === true;

    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
    const rows = r.data.values || [];

    // ── STEP 1: Creator cleanup ─────────────────────────────────────────────
    // Walk every Facebook/Instagram row and fix any creator field that's stuck on
    // a URL section keyword (e.g. "@p", "@reel", "@groups"). This uses NO external
    // HTTP calls — just re-runs extractCreator against the URL + title we already
    // have — so it's fast enough to process the whole sheet in one pass regardless
    // of BATCH_CAP. Runs first so the sheet's creator column is clean even for
    // rows that won't get a thumbnail this round.
    const creatorUpdates = [];
    let creatorsFixed = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const platform = row[0];
      if (platform !== 'Instagram' && platform !== 'Facebook') continue;
      const currentCreator = row[1] || '';
      const title = row[2] || '';
      const url = row[3] || '';
      if (!url) continue;
      // Only reprocess rows whose current creator looks like a reserved-word handle.
      // We strip the leading @ (if any) and check the lowercase segment against our set.
      const currentSeg = currentCreator.replace(/^@/, '').toLowerCase();
      if (!RESERVED_URL_SEGMENTS.has(currentSeg) && !currentSeg.endsWith('.php')) continue;
      // Try to derive a real creator. If nothing better is found, downgrade to "Unknown"
      // rather than leaving a fake-looking @-handle in the sheet.
      const better = extractCreator(url, title) || 'Unknown';
      if (better !== currentCreator) {
        creatorUpdates.push({
          range: `'${SHEET_NAME}'!B${i + 1}`,
          values: [[better]],
        });
        creatorsFixed++;
      }
    }
    if (creatorUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: creatorUpdates },
      });
    }

    // ── STEP 2: Thumbnail backfill ──────────────────────────────────────────
    // Find rows across all three platforms that need a thumbnail. In normal
    // mode we only process rows with a URL but no thumbnail yet. In force mode
    // we ALSO process rows whose existing thumbnail isn't yet a persistent
    // base64 data URL — those are the expired CDN links we want to swap out.
    const targets = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const platform = row[0];
      const url = row[3];
      const existingThumb = row[8];
      if (!url) continue;
      if (platform !== 'TikTok' && platform !== 'Instagram' && platform !== 'Facebook') continue;
      // Skip rows whose thumbnail is already a permanent base64 data URL — those
      // will never expire, no work needed there.
      const isPersistent = existingThumb && existingThumb.startsWith('data:image/');
      if (isPersistent) continue;
      // Skip rows with an existing (short-lived CDN) URL unless force is on.
      if (existingThumb && !force) continue;
      targets.push({ sheetRow: i + 1, url, platform });
    }

    // Base64 encoding + sharp resize is CPU-bound, ~50-150ms per image on the
    // Render free tier. Combined with the fetch time this is about 500ms-1s
    // per row. Cap at 60 to stay comfortably under Render's ~100s ceiling.
    const BATCH_CAP = 60;
    const batch = targets.slice(0, BATCH_CAP);

    const updates = []; // Google Sheets batchUpdate payload — one entry per cell we're writing
    const stats = { tiktok: 0, instagram: 0, facebook: 0, failed: 0, encoded: 0 };

    for (const t of batch) {
      try {
        // Step A: fetch the ephemeral CDN URL (oEmbed for TikTok, og:image for IG/FB).
        let cdnThumb = null;
        if (t.platform === 'TikTok') {
          cdnThumb = await fetchTikTokOembedThumb(t.url);
        } else {
          cdnThumb = await fetchOgImage(t.url);
        }
        if (!cdnThumb) { stats.failed++; continue; }

        // Step B: fetch the actual image bytes, resize+compress with sharp, and
        // base64-encode into a data URL. That data URL is fully self-contained
        // and can be dropped straight into <img src> — no external hosting, no
        // expiration ever possible.
        const dataUrl = await fetchAndEncodeThumb(cdnThumb);
        if (!dataUrl) { stats.failed++; continue; }

        updates.push({ range: `'${SHEET_NAME}'!I${t.sheetRow}`, values: [[dataUrl]] });
        stats.encoded++;
        if (t.platform === 'TikTok') stats.tiktok++;
        else if (t.platform === 'Instagram') stats.instagram++;
        else stats.facebook++;
      } catch (e) {
        stats.failed++;
      }
      // Small politeness delay so we don't hammer any single origin mid-batch
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Single batch write is much faster than one-cell-per-request
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates },
      });
    }

    console.log(`[Backfill] force=${force} creators_fixed=${creatorsFixed} encoded=${stats.encoded} tt=${stats.tiktok} ig=${stats.instagram} fb=${stats.facebook} failed=${stats.failed} remaining=${Math.max(0, targets.length - batch.length)}`);

    res.json({
      ok: true,
      force,
      checked: batch.length,
      updated: stats.tiktok + stats.instagram + stats.facebook,
      encoded: stats.encoded,
      byPlatform: { tiktok: stats.tiktok, instagram: stats.instagram, facebook: stats.facebook },
      creatorsFixed,
      failed: stats.failed,
      totalTargets: targets.length,
      remaining: Math.max(0, targets.length - batch.length),
    });
  } catch (err) {
    console.error('Backfill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: fetch a TikTok video URL's cover image via TikTok's public oEmbed endpoint.
// Free, no auth. Returns the thumbnail URL string, or null on any failure.
async function fetchTikTokOembedThumb(url) {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const r = await fetch(oembedUrl, { timeout: 8000 });
    if (!r.ok) return null;
    const data = await r.json();
    return data.thumbnail_url || null;
  } catch {
    return null;
  }
}

// Helper: fetch any URL's OpenGraph preview image by extracting the og:image meta tag.
// Different platforms respond differently to different User-Agents — Instagram in
// particular is stricter than Facebook, so we try a sequence of UAs and return the
// first one that yields a usable og:image. Order matters:
//   1. iPhone Safari — Instagram serves the fullest metadata to mobile Safari
//   2. facebookexternalhit — canonical link-preview bot, works reliably on FB pages
//   3. Chrome desktop — final fallback for anything the first two miss
async function fetchOgImage(url) {
  const uas = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  for (const ua of uas) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 8000,
        redirect: 'follow',
      });
      if (!r.ok) continue;
      const html = await r.text();
      // Match og:image OR og:image:secure_url — either attribute order
      const m = html.match(/<meta[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i);
      if (m && m[1]) return m[1];
    } catch {
      // Try the next UA in the list
    }
  }
  return null;
}

// Image proxy — routes CDN-restricted thumbnail URLs through our server so the browser
// isn't the one hotlinking them. Different CDNs have different requirements:
//   - Instagram (cdninstagram.com, instagram.*.fbcdn.net): needs Referer: instagram.com
//   - Facebook (fbcdn.net, facebook.com): needs Referer: facebook.com
//   - TikTok (tiktokcdn.com, tiktokcdn-us.com): needs Referer: tiktok.com
// Without the correct Referer, these CDNs return 403 with an empty body. With it,
// they serve the image normally because that's how a regular browser loading the
// same page would look. Whitelisted host list stays for open-proxy safety.
const ALLOWED_IMG_HOSTS = [
  'cdninstagram.com', 'fbcdn.net',       // Instagram/Facebook CDNs
  'tiktokcdn.com', 'tiktokcdn-us.com',   // TikTok CDNs
  'googleusercontent.com',                // Google Search snippet images
  'gstatic.com',                          // Google image thumbnails
];

// Given a hostname, return the appropriate Referer for that CDN. Instagram's regional
// CDNs sometimes live under instagram.*.fbcdn.net (both markers present) — the
// instagram.* prefix wins because those URLs come from Instagram post pages, so
// referring from instagram.com is what the browser would naturally send.
function refererForHost(hostname) {
  if (hostname.startsWith('instagram.') || hostname.endsWith('cdninstagram.com')) {
    return 'https://www.instagram.com/';
  }
  if (hostname.endsWith('fbcdn.net') || hostname.endsWith('facebook.com')) {
    return 'https://www.facebook.com/';
  }
  if (hostname.endsWith('tiktokcdn.com') || hostname.endsWith('tiktokcdn-us.com')) {
    return 'https://www.tiktok.com/';
  }
  return null; // Google hosts don't need a Referer
}

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
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    };
    const ref = refererForHost(parsed.hostname);
    if (ref) headers['Referer'] = ref;

    const upstream = await fetch(url, {
      headers,
      timeout: 10000,
    });
    if (!upstream.ok) {
      console.error(`Image proxy upstream error ${upstream.status} for host ${parsed.hostname}`);
      return res.status(upstream.status).send('Upstream error');
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    // Cache aggressively — thumbnail URLs are signed/effectively immutable, safe to cache
    res.set('Cache-Control', 'public, max-age=86400');
    upstream.body.pipe(res);
  } catch (err) {
    console.error(`Image proxy error for host ${parsed.hostname}:`, err.message);
    res.status(502).send('Proxy fetch failed');
  }
});

// YouTube search
app.get('/api/search', async (req, res) => {
  const { query, maxResults = 50, order = 'relevance', publishedAfter, publishedBefore, pageToken } = req.query;
  if (!query) return res.status(400).json({ error: 'Query required' });
  try {
    // maxResults default raised from 12 to 50 (the API's per-call max) so first-page
    // searches return real breadth. pageToken enables the "Load more" button on the
    // frontend to fetch subsequent pages by passing the token YouTube returned last time.
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${maxResults}&order=${order}&key=${YT_KEY}`;
    if (publishedAfter) url += `&publishedAfter=${publishedAfter}T00:00:00Z`;
    if (publishedBefore) url += `&publishedBefore=${publishedBefore}T23:59:59Z`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const ids = (data.items || []).map(i => i.id.videoId).filter(Boolean).join(',');
    // stats/duration lookup is a second API call — skip if there are no items to avoid an empty-id URL
    let statsMap = {};
    if (ids) {
      const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${YT_KEY}`;
      const statsRes = await fetch(statsUrl);
      const statsData = await statsRes.json();
      (statsData.items || []).forEach(v => { statsMap[v.id] = v; });
    }
    const results = (data.items || []).map(item => {
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
    // nextPageToken is what the frontend passes back on the next call to get more results;
    // it's null/absent when there are no more pages, which the frontend uses to hide "Load more".
    res.json({ ok: true, results, total: results.length, nextPageToken: data.nextPageToken || null });
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
