// config.js — update keywords and selectors here without touching scraper logic

module.exports = {
  // Keywords and hashtags to search
  keywords: (process.env.KEYWORDS || 'farmersdefense,farmers defense,#farmersdefense,#farmersdefensegloves')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean),

  // Output file path
  resultsFile: process.env.RESULTS_FILE || '../public/tiktok-results.json',

  // Max results per keyword
  maxResultsPerKeyword: 20,

  // Human-like delays (ms)
  delays: {
    betweenKeywords: [3000, 6000],   // random between 3-6 seconds
    betweenScrolls: [1500, 3000],     // random between 1.5-3 seconds
    afterSearch: [2000, 4000],        // random between 2-4 seconds
    pageLoad: [3000, 5000],           // random between 3-5 seconds
  },

  // TikTok selectors — update here if TikTok changes their UI
  selectors: {
    searchInput: 'input[type="search"], input[placeholder*="search"], input[placeholder*="Search"]',
    videoLinks: 'a[href*="/video/"]',
    videoCard: '[data-e2e="search_top-item"], [class*="DivItemContainer"], article',
    viewCount: '[data-e2e="video-views"], [class*="video-count"], strong',
    date: 'time, [class*="time"], [class*="date"]',
    caption: '[data-e2e="search-card-desc"], [class*="desc"], h1',
    username: '[data-e2e="search-card-user-unique-id"], [class*="UniqueId"], [href*="/@"]',
  },

  // Fallback selectors if primary ones fail
  fallbackSelectors: {
    videoLinks: ['a[href*="tiktok.com/@"]', 'a[href*="/video/"]', '[class*="video"] a'],
    username: ['[class*="author"]', '[class*="user"] a', 'a[href*="/@"]'],
  }
};
