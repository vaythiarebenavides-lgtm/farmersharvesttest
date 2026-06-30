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
const SHEET_RANGE = `'${SHEET_NAME}'!A:H`;
// Columns: Platform | Creator | Title/Caption | Link | Views | Date Posted | Date Discovered | Usage Rights

// ── ENSURE HEADERS EXIST ──
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

// Trigger TikTok harvest via GitHub Actions
app.post('/api/harvest-tiktok', async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'vaythiarebenavides-lgtm/farmersharvesttest';
  if (!token) return res.status(500).json({ error: 'GitHub token not configured' });
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/tiktok-scraper.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status === 204) {
      res.json({ ok: true, message: 'TikTok harvest triggered successfully' });
    } else {
      const err = await r.text();
      res.status(400).json({ error: 'GitHub API error: ' + err });
    }
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
