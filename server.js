const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const YT_KEY = process.env.YOUTUBE_API_KEY;

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
        description: item.snippet.description,
        date: item.snippet.publishedAt?.split('T')[0],
        thumb: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url,
        views: formatViews(views),
        viewsNum: views,
        platform: 'yt',
        type: isShort ? 'short' : 'video',
        ytId: vid,
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
