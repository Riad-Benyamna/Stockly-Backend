const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
require("dotenv").config();
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3001;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const NEWS_KEY = process.env.NEWS_API_KEY;
const PRICE_KEY = process.env.ALPHA_VANTAGE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// ==========================================
// DATABASE CONNECTION
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('❌ Database error:', err);
  } else {
    console.log('✅ Database connected');
    
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255),
          picture VARCHAR(500),
          google_id VARCHAR(255) UNIQUE,
          auth_token VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_token ON users(auth_token);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
      
      console.log('✅ Users table ready');
    } catch (err) {
      console.error('❌ Table creation error:', err);
    }
  }
});

// ==========================================
// GOOGLE OAUTH
// ==========================================
app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body;
  
  console.log('=== OAuth Request Received ===');
  console.log('Token received:', idToken ? 'Yes' : 'No');
  
  if (!idToken) {
    console.log('❌ No token provided');
    return res.status(400).json({ error: 'Missing Google token' });
  }
  
  try {
    console.log('Verifying token with Google...');
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    const googleData = await response.json();
    
    console.log('Google response status:', response.status);
    console.log('Google response:', JSON.stringify(googleData, null, 2));
    
    if (googleData.error || response.status !== 200) {
      console.error('❌ Google rejected token:', googleData.error_description || googleData.error);
      return res.status(401).json({ 
        error: 'Invalid Google token',
        details: googleData.error_description || 'Token verification failed'
      });
    }
    
    const { email, name, picture, sub: googleId } = googleData;
    
    console.log('✅ Token valid for:', email);
    
    let user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (user.rows.length === 0) {
      const authToken = crypto.randomBytes(32).toString('hex');
      user = await pool.query(
        'INSERT INTO users (email, name, picture, google_id, auth_token) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [email, name, picture, googleId, authToken]
      );
      console.log('✅ New user created:', email);
    } else {
      await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.rows[0].id]);
      console.log('✅ User logged in:', email);
    }
    
    const userData = user.rows[0];
    res.json({
      success: true,
      user: { 
        id: userData.id, 
        email: userData.email, 
        name: userData.name, 
        picture: userData.picture, 
        token: userData.auth_token 
      }
    });
    
  } catch (err) {
    console.error('❌ OAuth error:', err);
    res.status(500).json({ error: 'Authentication failed', details: err.message });
  }
});

app.post('/auth/verify', async (req, res) => {
  const { token } = req.body;
  try {
    const result = await pool.query('SELECT id, email, name, picture FROM users WHERE auth_token = $1', [token]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
    res.json({ valid: true, user: result.rows[0] });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
async function authenticateUser(req, res, next) {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE auth_token = $1', [token]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Utility: Analyze news sentiment
const analyzeNewsSentiment = (news, ticker) => {
  if (!news.length) return { score: 50, label: 'Neutral', color: '#6b7280' };
  
  const strongPositive = ['surge', 'soar', 'jump', 'rally', 'beat', 'exceed', 'upgrade', 'breakthrough', 'record', 'best'];
  const moderatePositive = ['growth', 'gain', 'rise', 'up', 'profit', 'strong', 'increase', 'positive', 'success', 'improve'];
  
  const strongNegative = ['plunge', 'crash', 'collapse', 'miss', 'downgrade', 'loss', 'worst', 'fail', 'cut'];
  const moderateNegative = ['fall', 'drop', 'decline', 'down', 'weak', 'concern', 'risk', 'struggle', 'pressure'];
  
  let sentimentScore = 0;
  let relevanceScore = 0;
  
  news.forEach(article => {
    const text = (article.title + ' ' + (article.description || '')).toLowerCase();
    
    if (text.includes(ticker.toLowerCase())) {
      relevanceScore += 20;
      
      strongPositive.forEach(word => { if (text.includes(word)) sentimentScore += 15; });
      strongNegative.forEach(word => { if (text.includes(word)) sentimentScore -= 15; });
      
      moderatePositive.forEach(word => { if (text.includes(word)) sentimentScore += 5; });
      moderateNegative.forEach(word => { if (text.includes(word)) sentimentScore -= 5; });
    } else {
      relevanceScore -= 10;
    }
  });
  
  const score = Math.max(0, Math.min(100, 50 + sentimentScore + (relevanceScore / news.length)));
  
  let label = 'Neutral', color = '#6b7280';
  
  if (score >= 70) { label = 'Positive'; color = '#10b981'; }
  else if (score >= 60) { label = 'Slightly Positive'; color = '#3b82f6'; }
  else if (score >= 55) { label = 'Neutral-Positive'; color = '#6b7280'; }
  else if (score >= 45) { label = 'Neutral'; color = '#6b7280'; }
  else if (score >= 40) { label = 'Neutral-Negative'; color = '#f59e0b'; }
  else if (score >= 30) { label = 'Slightly Negative'; color = '#f59e0b'; }
  else { label = 'Negative'; color = '#ef4444'; }
  
  return { score: Math.round(score), label, color };
};

// ==========================================
// CRYPTO HANDLER
// ==========================================
async function handleCryptoAnalysis(ticker, res) {
  try {
    const cryptoIds = {
      'BTC': 'bitcoin', 'ETH': 'ethereum', 'DOGE': 'dogecoin', 
      'SOL': 'solana', 'ADA': 'cardano', 'XRP': 'ripple',
      'DOT': 'polkadot', 'MATIC': 'polygon', 'AVAX': 'avalanche-2',
      'LINK': 'chainlink', 'UNI': 'uniswap', 'LTC': 'litecoin',
      'BCH': 'bitcoin-cash', 'SHIB': 'shiba-inu', 'ATOM': 'cosmos',
      'XLM': 'stellar', 'ALGO': 'algorand', 'VET': 'vechain'
    };
    
    const coinId = cryptoIds[ticker.toUpperCase()] || ticker.toLowerCase();
    
    let price = null, change24h = null, changePct = null, volume = null, marketCap = null, high24h = null, low24h = null;
    
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
      const data = await r.json();
      
      if (data.market_data) {
        price = data.market_data.current_price.usd.toFixed(2);
        changePct = data.market_data.price_change_percentage_24h.toFixed(2);
        change24h = data.market_data.price_change_24h.toFixed(2);
        volume = data.market_data.total_volume.usd.toLocaleString('en-US', { maximumFractionDigits: 0 });
        marketCap = (data.market_data.market_cap.usd / 1e9).toFixed(2);
        high24h = data.market_data.high_24h.usd.toFixed(2);
        low24h = data.market_data.low_24h.usd.toFixed(2);
      }
    } catch (e) {
      console.error("CoinGecko fetch error:", e.message);
    }

    let news = [];
    if (NEWS_KEY) {
      try {
        const since = new Date(Date.now() - 3*24*60*60*1000).toISOString();
        const cryptoName = coinId.charAt(0).toUpperCase() + coinId.slice(1).replace('-', ' ');
        
        const domains = 'coindesk.com,cointelegraph.com,decrypt.co,theblock.co,coinmarketcap.com,bitcoin.com';
        let r = await fetch(`https://newsapi.org/v2/everything?q="${ticker}" OR "${cryptoName}"&domains=${domains}&language=en&from=${since}&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`);
        let d = await r.json();
        
        if (d.articles?.length) {
          news = d.articles.slice(0, 3).map(a => ({
            title: a.title,
            source: a.source.name,
            time: Math.floor((Date.now() - new Date(a.publishedAt)) / 3600000),
            url: a.url
          }));
        }
      } catch (e) {
        console.error("Crypto news error:", e.message);
      }
    }

    const pct = changePct ? parseFloat(changePct) : 0;
    let score = 50;
    
    if (pct > 20) score += 25;
    else if (pct > 10) score += 20;
    else if (pct > 5) score += 15;
    else if (pct > 2) score += 10;
    else if (pct > 0) score += 5;
    else if (pct > -2) score -= 5;
    else if (pct > -5) score -= 10;
    else if (pct > -10) score -= 15;
    else if (pct > -20) score -= 20;
    else score -= 25;
    
    if (news.length >= 3) score += 15;
    else if (news.length >= 2) score += 10;
    else if (news.length >= 1) score += 5;
    
    score = Math.max(0, Math.min(100, Math.round(score)));

    let interestLevel = "Neutral Activity";
    let interestColor = "#6b7280";
    if (score >= 75) { interestLevel = "High Market Interest"; interestColor = "#10b981"; }
    else if (score >= 60) { interestLevel = "Elevated Interest"; interestColor = "#3b82f6"; }
    else if (score >= 40) { interestLevel = "Neutral Activity"; interestColor = "#6b7280"; }
    else if (score >= 25) { interestLevel = "Below Average Interest"; interestColor = "#f59e0b"; }
    else { interestLevel = "Low Market Interest"; interestColor = "#ef4444"; }

    const prompt = `You're a cryptocurrency market analyst providing educational context for ${ticker}.

CURRENT DATA:
- Price: $${price} (${changePct}% in 24h)
- 24h Range: $${low24h} - $${high24h}
- Market Cap: $${marketCap}B
- 24h Volume: $${volume}
${news.length ? `\nRECENT CRYPTO NEWS:\n${news.map(n => `• ${n.source} (${n.time}h ago): ${n.title}`).join('\n')}` : '\n• Limited crypto news coverage in past 72 hours'}

Write a focused 4-section analysis (90 words). Use numbered format:

1. MARKET CONTEXT
Explain the 24h price movement for ${ticker}. What's driving this crypto specifically?

2. KEY WATCHPOINTS
List 2-3 crypto-specific factors traders monitor for ${ticker}. Use bullets (•).

3. RISK CONSIDERATIONS  
Identify 1-2 risks specific to this cryptocurrency. Use bullets (•).

4. RESEARCH CHECKLIST
One sentence: what should crypto traders verify about ${ticker} before taking a position?

RULES:
- Be SPECIFIC to ${ticker}
- NO stock market terminology
- Third-person only
- Plain text, NO markdown
- Start each section with number`;

    const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.25
      })
    });
    
    const aiData = await aiResponse.json();
    let aiAnalysis = aiData.choices?.[0]?.message?.content || "Analysis temporarily unavailable.";

    const sectionRegex = /(\d+\.\s+[A-Z\s]+)\n([\s\S]*?)(?=\d+\.\s+[A-Z\s]+|$)/g;
    const sections = [];
    let match;
    
    while ((match = sectionRegex.exec(aiAnalysis)) !== null) {
      const title = match[1].trim().replace(/^\d+\.\s+/, '');
      const content = match[2].trim();
      sections.push({ title, content });
    }
    
    if (sections.length === 0) {
      const parts = aiAnalysis.split(/\d+\.\s+/).filter(s => s.trim());
      if (parts.length >= 4) {
        sections.push(
          { title: 'MARKET CONTEXT', content: parts[0] },
          { title: 'KEY WATCHPOINTS', content: parts[1] },
          { title: 'RISK CONSIDERATIONS', content: parts[2] },
          { title: 'RESEARCH CHECKLIST', content: parts[3] }
        );
      }
    }
    
    const sectionColors = {
      'MARKET CONTEXT': { bg: 'rgba(251,191,36,0.06)', border: '#fbbf24', icon: '📊' },
      'KEY WATCHPOINTS': { bg: 'rgba(59,130,246,0.06)', border: '#3b82f6', icon: '👁️' },
      'RISK CONSIDERATIONS': { bg: 'rgba(239,68,68,0.06)', border: '#ef4444', icon: '⚠️' },
      'RESEARCH CHECKLIST': { bg: 'rgba(16,185,129,0.06)', border: '#10b981', icon: '✓' }
    };

    const headerBadge = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:rgba(15,15,15,0.95);border-bottom:1px solid rgba(249,115,22,0.2);font-size:10px;">
        <span style="color:#888;">🪙 Crypto Analysis Tool</span>
        <span style="color:#666;">Educational Only • Not Financial Advice</span>
      </div>
    `;

    const priceCard = price ? `
      <div style="background:linear-gradient(135deg,rgba(15,15,15,0.95),rgba(25,25,35,0.95));border:1px solid rgba(249,115,22,0.3);border-radius:12px;padding:20px;margin:16px 0;backdrop-filter:blur(10px);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Latest Price</div>
            <div style="font-size:32px;font-weight:700;color:#fff;line-height:1;">$${price}</div>
          </div>
          <div style="text-align:right;">
            <div style="display:inline-block;padding:6px 12px;background:${change24h >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'};border:1px solid ${change24h >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'};border-radius:6px;">
              <div style="font-size:18px;font-weight:700;color:${change24h >= 0 ? '#10b981' : '#ef4444'};">${change24h >= 0 ? '+' : ''}$${change24h}</div>
              <div style="font-size:13px;font-weight:600;color:${change24h >= 0 ? '#10b981' : '#ef4444'};">${change24h >= 0 ? '+' : ''}${changePct}%</div>
            </div>
          </div>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">24H HIGH</div>
            <div style="font-size:14px;font-weight:600;color:#10b981;">$${high24h}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">24H LOW</div>
            <div style="font-size:14px;font-weight:600;color:#ef4444;">$${low24h}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">MARKET CAP</div>
            <div style="font-size:14px;font-weight:600;color:#f59e0b;">$${marketCap}B</div>
          </div>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
          <div style="font-size:10px;color:#666;margin-bottom:4px;">24H VOLUME</div>
          <div style="font-size:14px;font-weight:600;color:#3b82f6;">$${volume}</div>
        </div>
      </div>
    ` : '';

    const signalsSection = `
      <div style="margin:16px 0;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">⚡ Market Signals</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div style="padding:12px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.25);border-radius:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:4px;">24H MOVEMENT</div>
            <div style="font-size:16px;font-weight:700;color:${Math.abs(pct) > 10 ? '#f59e0b' : Math.abs(pct) > 5 ? '#3b82f6' : '#6b7280'};">
              ${Math.abs(pct) > 10 ? 'High Volatility' : Math.abs(pct) > 5 ? 'Moderate Move' : 'Stable'}
            </div>
          </div>
          <div style="padding:12px;background:rgba(249,115,22,0.1);border:1px solid rgba(249,115,22,0.25);border-radius:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:4px;">MARKET INTEREST</div>
            <div style="font-size:16px;font-weight:700;color:${interestColor};">${interestLevel.split(' ')[0]}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;">${score}/100</div>
          </div>
        </div>
      </div>
    `;

    const newsSection = news.length ? `
      <div style="margin:16px 0;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">📰 Recent Crypto News</div>
        ${news.map(n => `
          <div style="padding:12px;margin-bottom:8px;background:rgba(249,115,22,0.04);border-left:3px solid #f97316;border-radius:6px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
              <span style="font-size:10px;color:#666;">${n.source}</span>
              <span style="font-size:10px;color:#666;">${n.time}h ago</span>
            </div>
            <div style="font-size:13px;line-height:1.4;color:#e0e0e0;">${n.title}</div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div style="margin:16px 0;padding:16px;background:rgba(107,114,128,0.08);border:1px dashed rgba(107,114,128,0.2);border-radius:8px;text-align:center;">
        <div style="font-size:13px;color:#888;">📭 Limited crypto news in past 72 hours</div>
      </div>
    `;

    const formattedAnalysis = sections.length >= 3 ? `
      <div style="margin:16px 0;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">💡 Crypto Market Context</div>
        ${sections.map(section => {
          const style = sectionColors[section.title] || { bg: 'rgba(107,114,128,0.06)', border: '#6b7280', icon: '•' };
          return `
            <div style="margin-bottom:16px;padding:14px;background:${style.bg};border-left:3px solid ${style.border};border-radius:6px;">
              <div style="font-size:10px;color:${style.border};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${style.icon} ${section.title}</div>
              <div style="font-size:13px;line-height:1.6;color:#e0e0e0;">${section.content}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    const actionPanel = `
      <div style="margin:20px 0;padding:16px;background:linear-gradient(135deg,rgba(249,115,22,0.08),rgba(251,146,60,0.08));border:1px solid rgba(249,115,22,0.2);border-radius:10px;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">🎯 Before Trading Crypto</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#f97316;">□</span> Check on-chain metrics
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#f97316;">□</span> Review protocol updates
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#f97316;">□</span> Monitor whale activity
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#f97316;">□</span> Assess risk tolerance
          </div>
        </div>
      </div>
    `;

    const footerDisclaimer = `
      <div style="margin-top:20px;padding:12px;background:rgba(0,0,0,0.4);border-top:1px solid rgba(255,255,255,0.05);border-radius:0 0 12px 12px;font-size:10px;line-height:1.5;color:#666;text-align:center;">
        <div style="margin-bottom:4px;">
          <span style="color:#f97316;">⚠️</span> <strong style="color:#888;">Educational crypto research tool</strong> • General information only
        </div>
        <div>
          Not financial advice • Crypto is highly volatile • Never invest more than you can afford to lose
        </div>
      </div>
    `;

    const fullResponse = headerBadge + priceCard + signalsSection + newsSection + formattedAnalysis + actionPanel + footerDisclaimer;

    res.json({ result: fullResponse });
    
  } catch (err) {
    console.error("❌ Crypto analysis error:", err.message);
    res.json({ 
      result: `
        <div style="padding:40px 20px;text-align:center;background:rgba(15,15,15,0.95);border-radius:12px;">
          <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
          <div style="font-size:16px;color:#e0e0e0;margin-bottom:8px;">Crypto Analysis Unavailable</div>
          <div style="font-size:13px;color:#888;">Please try again in a moment</div>
        </div>
      ` 
    });
  }
}

app.post("/analyze", authenticateUser, async (req, res) => {
  const { ticker, isCrypto } = req.body;
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  try {
    const knownCryptoTickers = ['BTC', 'ETH', 'DOGE', 'SOL', 'ADA', 'XRP', 'DOT', 'MATIC', 'AVAX', 'LINK', 'UNI', 'LTC', 'BCH', 'SHIB', 'ATOM', 'XLM', 'ALGO', 'VET', 'PEPE', 'ARB', 'OP', 'RNDR', 'AAVE', 'MKR', 'SNX'];
    const detectAsCrypto = isCrypto || knownCryptoTickers.includes(ticker.toUpperCase());
    
    if (detectAsCrypto) {
      return await handleCryptoAnalysis(ticker, res);
    }
    
    // Get company description from Alpha Vantage
    let companyDescription = null;
    let companySector = null;
    let companyIndustry = null;

    if (PRICE_KEY) {
      try {
        const overviewRes = await fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${PRICE_KEY}`);
        const overview = await overviewRes.json();

        if (overview && overview.Symbol) {
          companyDescription = overview.Description || null;
          companySector = overview.Sector || null;
          companyIndustry = overview.Industry || null;
        }
      } catch (e) {
        console.error("Company info fetch error:", e.message);
      }
    }

    let news = [];
    if (NEWS_KEY) {
      try {
        const since = new Date(Date.now() - 3*24*60*60*1000).toISOString();
        
        const tickerToName = {
          'AAPL': 'Apple', 'TSLA': 'Tesla', 'MSFT': 'Microsoft', 'GOOGL': 'Google Alphabet',
          'AMZN': 'Amazon', 'AMD': 'AMD Advanced Micro Devices', 'NVDA': 'NVIDIA', 
          'META': 'Meta Facebook', 'NFLX': 'Netflix', 'INTC': 'Intel'
        };
        const companyName = tickerToName[ticker] || ticker;
        
        const financialDomains = 'bloomberg.com,reuters.com,cnbc.com,marketwatch.com,seekingalpha.com,fool.com,investopedia.com,barrons.com,wsj.com,ft.com,yahoo.com,benzinga.com,thestreet.com';
        
        let r = await fetch(`https://newsapi.org/v2/everything?q="${ticker}" OR "${companyName}"&domains=${financialDomains}&language=en&from=${since}&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`);
        let d = await r.json();
        
        if (!d.articles?.length) {
          r = await fetch(`https://newsapi.org/v2/everything?q="${ticker}" AND (stock OR shares OR earnings OR trading)&language=en&from=${since}&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`);
          d = await r.json();
        }
        
        if (d.articles?.length) {
          const relevantArticles = d.articles.filter(a => {
            const title = a.title.toLowerCase();
            const description = (a.description || '').toLowerCase();
            const fullText = title + ' ' + description;
            
            const mentionsCompany = title.includes(ticker.toLowerCase()) || 
                                   companyName.toLowerCase().split(' ').some(word => 
                                     word.length > 3 && title.includes(word.toLowerCase())
                                   );
            
            const stockKeywords = ['stock', 'shares', 'trading', 'investor', 'market', 'price', 'earnings', 'revenue', 'quarter', 'analyst', 'upgrade', 'downgrade', 'wall street', 'profit', 'loss'];
            const hasStockKeywords = stockKeywords.some(keyword => fullText.includes(keyword));
            
            return mentionsCompany && hasStockKeywords;
          });
          
          news = relevantArticles.slice(0, 3).map(a => ({
            title: a.title,
            source: a.source.name,
            time: Math.floor((Date.now() - new Date(a.publishedAt)) / 3600000),
            url: a.url
          }));
        }
      } catch (e) {
        console.error("News fetch error:", e.message);
      }
    }

    const sentiment = analyzeNewsSentiment(news, ticker);


    // Simplified analysis prompt
    const simplifiedPrompt = `You're explaining ${ticker} stock to a complete beginner in simple terms.

COMPANY INFO:
${companyDescription ? `- Business: ${companyDescription.substring(0, 200)}...` : '- Company operates in the financial markets'}
${companySector ? `- Sector: ${companySector}` : ''}

${news.length ? `RECENT NEWS:\n${news.map(n => `• ${n.source}: ${n.title}`).join('\n')}` : 'RECENT NEWS:\n• Limited news coverage'}

Write a 3-section analysis (100 words total). Use EXACT numbered format:

1. WHAT THEY DO
One clear sentence explaining ${ticker}'s business. Example: "Apple makes iPhones and computers."

2. GOOD SIGNS
List 2-3 positive facts about ${ticker} from news or business. Use bullets (•). Keep it simple - what's going well?

3. WARNING SIGNS
List 2-3 concerns or risks about ${ticker}. Use bullets (•). What should someone watch out for?

RULES:
- Write for a beginner - very simple language
- NO jargon or technical terms
- Use plain text, NO markdown
- Start each section with "1.", "2.", "3."`;

    // Detailed analysis prompt
    const detailedPrompt = `You're a financial analyst providing educational research guidance for ${ticker} stock.

COMPANY INFO:
${companyDescription ? `- Business: ${companyDescription.substring(0, 200)}...` : '- Company operates in the financial markets'}
${companySector ? `- Sector: ${companySector}` : ''}
${companyIndustry ? `- Industry: ${companyIndustry}` : ''}

${news.length ? `RECENT FINANCIAL NEWS:\n${news.map(n => `• ${n.source} (${n.time}h ago): ${n.title}`).join('\n')}` : 'RECENT FINANCIAL NEWS:\n• Limited news coverage in past 72 hours'}

Write a focused 3-section analysis (120 words). Use EXACT numbered format:

1. BUSINESS MODEL
In 2-3 sentences, explain ${ticker}'s business model. What do they sell/provide? Who are their customers? What's their competitive position?

2. KEY RESEARCH QUESTIONS
List 3-4 specific questions an investor should answer about ${ticker} before investing. Use bullet points (•). Focus on: revenue sources, competitive position, growth drivers, and recent developments.

3. RISK FACTORS
List 2-3 specific risks or concerns to verify about ${ticker}. Use bullet points (•). Be specific to this company's situation.

RULES:
- Be SPECIFIC to ${ticker} and their actual business
- Use technical/professional language
- Use plain text, NO markdown
- Third-person only
- Start each section with "1.", "2.", "3."`;

    // Fetch both simplified and detailed analyses
    const [simplifiedResponse, detailedResponse] = await Promise.all([
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: simplifiedPrompt }],
          max_tokens: 250,
          temperature: 0.25
        })
      }),
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: detailedPrompt }],
          max_tokens: 300,
          temperature: 0.25
        })
      })
    ]);

    const simplifiedData = await simplifiedResponse.json();
    const detailedData = await detailedResponse.json();

    let simplifiedAnalysis = simplifiedData.choices?.[0]?.message?.content || "";
    let detailedAnalysis = detailedData.choices?.[0]?.message?.content || "";

    // Parse simplified analysis
    const parseSimplifiedSections = (text) => {
      const sectionRegex = /(\d+\.\s+[A-Z\s]+)\n([\s\S]*?)(?=\d+\.\s+[A-Z\s]+|$)/g;
      const sections = [];
      let match;

      while ((match = sectionRegex.exec(text)) !== null) {
        const title = match[1].trim().replace(/^\d+\.\s+/, '');
        const content = match[2].trim();
        sections.push({ title, content });
      }

      if (sections.length === 0) {
        const parts = text.split(/\d+\.\s+/).filter(s => s.trim());
        if (parts.length >= 3) {
          sections.push(
            { title: 'WHAT THEY DO', content: parts[0] },
            { title: 'GOOD SIGNS', content: parts[1] },
            { title: 'WARNING SIGNS', content: parts[2] }
          );
        }
      }

      return sections;
    };

    // Parse detailed analysis
    const parseDetailedSections = (text) => {
      const sectionRegex = /(\d+\.\s+[A-Z\s]+)\n([\s\S]*?)(?=\d+\.\s+[A-Z\s]+|$)/g;
      const sections = [];
      let match;

      while ((match = sectionRegex.exec(text)) !== null) {
        const title = match[1].trim().replace(/^\d+\.\s+/, '');
        const content = match[2].trim();
        sections.push({ title, content });
      }

      if (sections.length === 0) {
        const parts = text.split(/\d+\.\s+/).filter(s => s.trim());
        if (parts.length >= 3) {
          sections.push(
            { title: 'BUSINESS MODEL', content: parts[0] },
            { title: 'KEY RESEARCH QUESTIONS', content: parts[1] },
            { title: 'RISK FACTORS', content: parts[2] }
          );
        }
      }

      return sections;
    };

    const simplifiedSections = parseSimplifiedSections(simplifiedAnalysis);
    const detailedSections = parseDetailedSections(detailedAnalysis);

    const headerBadge = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:rgba(15,15,15,0.95);border-bottom:1px solid rgba(46,185,224,0.15);font-size:10px;">
        <span style="color:#888;">🤖 AI-Enhanced Research Tool</span>
        <span style="color:#666;">General Information • Not Advice</span>
      </div>
    `;

    // Tab navigation with inline onclick handlers
    const tabNav = `
      <div style="display:flex;gap:8px;padding:16px 16px 0 16px;background:rgba(15,15,15,0.95);">
        <button id="tab-simplified" onclick="
          document.getElementById('tab-simplified').style.background='linear-gradient(135deg,#667eea,#764ba2)';
          document.getElementById('tab-simplified').style.color='white';
          document.getElementById('tab-detailed').style.background='rgba(255,255,255,0.05)';
          document.getElementById('tab-detailed').style.color='#888';
          document.getElementById('content-simplified').style.display='block';
          document.getElementById('content-detailed').style.display='none';
        " style="flex:1;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s;">
          📋 Simplified
        </button>
        <button id="tab-detailed" onclick="
          document.getElementById('tab-simplified').style.background='rgba(255,255,255,0.05)';
          document.getElementById('tab-simplified').style.color='#888';
          document.getElementById('tab-detailed').style.background='linear-gradient(135deg,#667eea,#764ba2)';
          document.getElementById('tab-detailed').style.color='white';
          document.getElementById('content-simplified').style.display='none';
          document.getElementById('content-detailed').style.display='block';
        " style="flex:1;padding:12px;background:rgba(255,255,255,0.05);color:#888;border:none;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s;">
          📊 Detailed
        </button>
      </div>
    `;

    // Simplified content (always shown by default)
    const simplifiedSectionColors = {
      'WHAT THEY DO': { bg: 'rgba(102,126,234,0.08)', border: '#667eea', icon: '🏢' },
      'GOOD SIGNS': { bg: 'rgba(16,185,129,0.08)', border: '#10b981', icon: '✅' },
      'WARNING SIGNS': { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚠️' }
    };

    const simplifiedContent = `
      <div id="content-simplified" style="display:block;">
        ${companySector ? `
          <div style="margin:16px;padding:10px;background:rgba(102,126,234,0.1);border-radius:8px;text-align:center;">
            <span style="font-size:12px;color:#667eea;font-weight:600;">${companySector}${companyIndustry ? ` • ${companyIndustry}` : ''}</span>
          </div>
        ` : ''}

        ${simplifiedSections.length >= 3 ? `
          <div style="padding:16px;">
            ${simplifiedSections.map(section => {
              const style = simplifiedSectionColors[section.title] || { bg: 'rgba(107,114,128,0.06)', border: '#6b7280', icon: '•' };
              return `
                <div style="margin-bottom:20px;padding:16px;background:${style.bg};border-left:4px solid ${style.border};border-radius:8px;">
                  <div style="font-size:11px;color:${style.border};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">${style.icon} ${section.title}</div>
                  <div style="font-size:14px;line-height:1.7;color:#e0e0e0;">${section.content}</div>
                </div>
              `;
            }).join('')}
          </div>
        ` : '<div style="padding:40px 20px;text-align:center;color:#888;">Analysis not available</div>'}

        ${news.length ? `
          <div style="padding:0 16px 16px 16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">📰 Recent News (${news.length})</div>
            <div style="font-size:12px;color:#aaa;margin-bottom:8px;">Sentiment: <span style="color:${sentiment.color};font-weight:600;">${sentiment.label}</span></div>
          </div>
        ` : ''}
      </div>
    `;

    // Detailed content (hidden by default)
    const detailedSectionColors = {
      'BUSINESS MODEL': { bg: 'rgba(102,126,234,0.06)', border: '#667eea', icon: '🏢' },
      'KEY RESEARCH QUESTIONS': { bg: 'rgba(59,130,246,0.06)', border: '#3b82f6', icon: '🔍' },
      'RISK FACTORS': { bg: 'rgba(239,68,68,0.06)', border: '#ef4444', icon: '⚠️' }
    };

    const detailedContent = `
      <div id="content-detailed" style="display:none;">
        ${companyDescription || companySector ? `
          <div style="margin:16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">🏢 Company Overview</div>
            <div style="background:linear-gradient(135deg,rgba(15,15,15,0.95),rgba(25,25,35,0.95));border:1px solid rgba(102,126,234,0.2);border-radius:12px;padding:16px;">
              ${companySector || companyIndustry ? `
                <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
                  ${companySector ? `<span style="padding:6px 12px;background:rgba(102,126,234,0.15);border:1px solid rgba(102,126,234,0.3);border-radius:20px;font-size:11px;color:#667eea;">${companySector}</span>` : ''}
                  ${companyIndustry ? `<span style="padding:6px 12px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:20px;font-size:11px;color:#3b82f6;">${companyIndustry}</span>` : ''}
                </div>
              ` : ''}
              ${companyDescription ? `
                <div style="font-size:13px;line-height:1.6;color:#d0d0d0;">${companyDescription.length > 350 ? companyDescription.substring(0, 350) + '...' : companyDescription}</div>
              ` : '<div style="font-size:13px;line-height:1.6;color:#888;font-style:italic;">Company description not available</div>'}
            </div>
          </div>
        ` : ''}

        ${news.length ? `
          <div style="margin:16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">📰 Recent Headlines</div>
            ${news.map(n => `
              <div style="padding:12px;margin-bottom:8px;background:rgba(46,185,224,0.04);border-left:3px solid #2eb9e0;border-radius:6px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
                  <span style="font-size:10px;color:#666;">${n.source}</span>
                  <span style="font-size:10px;color:#666;">${n.time}h ago</span>
                </div>
                <div style="font-size:13px;line-height:1.4;color:#e0e0e0;">${n.title}</div>
              </div>
            `).join('')}
            <div style="margin-top:12px;padding:10px;background:rgba(${sentiment.color === '#10b981' ? '16,185,129' : sentiment.color === '#ef4444' ? '239,68,68' : '107,114,128'},0.1);border-radius:6px;">
              <span style="font-size:11px;color:#888;">Overall Sentiment: </span>
              <span style="color:${sentiment.color};font-weight:600;font-size:12px;">${sentiment.label} (${sentiment.score}/100)</span>
            </div>
          </div>
        ` : `
          <div style="margin:16px;padding:16px;background:rgba(107,114,128,0.08);border:1px dashed rgba(107,114,128,0.2);border-radius:8px;text-align:center;">
            <div style="font-size:13px;color:#888;">📭 Limited news coverage in past 72 hours</div>
          </div>
        `}

        ${detailedSections.length >= 3 ? `
          <div style="margin:16px;">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">🎓 Research Guide</div>
            ${detailedSections.map(section => {
              const style = detailedSectionColors[section.title] || { bg: 'rgba(107,114,128,0.06)', border: '#6b7280', icon: '•' };
              return `
                <div style="margin-bottom:16px;padding:14px;background:${style.bg};border-left:3px solid ${style.border};border-radius:6px;">
                  <div style="font-size:10px;color:${style.border};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${style.icon} ${section.title}</div>
                  <div style="font-size:13px;line-height:1.6;color:#e0e0e0;">${section.content}</div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}

        <div style="margin:16px;padding:16px;background:linear-gradient(135deg,rgba(102,126,234,0.08),rgba(118,75,162,0.08));border:1px solid rgba(102,126,234,0.2);border-radius:10px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">📝 Before Investing</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
              <span style="color:#667eea;">□</span> Read earnings reports
            </div>
            <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
              <span style="color:#667eea;">□</span> Check competitor news
            </div>
            <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
              <span style="color:#667eea;">□</span> Review recent filings
            </div>
            <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
              <span style="color:#667eea;">□</span> Understand the risks
            </div>
          </div>
        </div>
      </div>
    `;

    const footerDisclaimer = `
      <div style="padding:12px;background:rgba(0,0,0,0.4);border-top:1px solid rgba(255,255,255,0.05);font-size:10px;line-height:1.5;color:#666;text-align:center;">
        <div style="margin-bottom:4px;">
          <span style="color:#fbbf24;">⚠️</span> <strong style="color:#888;">Educational research tool</strong> • General market information only
        </div>
        <div>
          Not personalized advice • Always conduct your own due diligence
        </div>
      </div>
    `;

    const fullResponse = headerBadge + tabNav + simplifiedContent + detailedContent + footerDisclaimer;

    res.json({ result: fullResponse });

  } catch (err) {
    console.error("❌ Analysis error:", err.message);
    res.json({ 
      result: `
        <div style="padding:40px 20px;text-align:center;background:rgba(15,15,15,0.95);border-radius:12px;">
          <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
          <div style="font-size:16px;color:#e0e0e0;margin-bottom:8px;">Analysis Temporarily Unavailable</div>
          <div style="font-size:13px;color:#888;">Please try again in a moment</div>
        </div>
      ` 
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   📊 Stockly Professional Backend     ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`\n📡 API Status:`);
  console.log(`   ${OPENROUTER_KEY ? '✓' : '✗'} OpenRouter (AI Research Guidance)`);
  console.log(`   ${NEWS_KEY ? '✓' : '✗'} NewsAPI (Headlines)`);
  console.log(`   ${PRICE_KEY ? '✓' : '✗'} Alpha Vantage (Company Info)`);
  console.log(`\n🔒 Legal Framework: Active`);
  console.log(`   ✓ Educational framing`);
  console.log(`   ✓ Non-prescriptive language`);
  console.log(`   ✓ Proper disclaimers`);
  console.log(`   ✓ Mechanical scoring\n`);
});
