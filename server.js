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

// Utility: Calculate technical indicators
const calculateTechnicalSignals = (priceData, changePct) => {
  const signals = [];
  const pct = parseFloat(changePct);
  
  if (Math.abs(pct) > 5) signals.push({ type: 'momentum', text: 'High volatility day', color: '#f59e0b' });
  if (pct > 3) signals.push({ type: 'bullish', text: 'Strong upward momentum', color: '#10b981' });
  if (pct < -3) signals.push({ type: 'bearish', text: 'Downward pressure', color: '#ef4444' });
  
  return signals;
};

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
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Current Price</div>
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
    
    let price = null, change = null, changePct = null, volume = null, high = null, low = null;
    
    if (PRICE_KEY) {
      try {
        const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${PRICE_KEY}`);
        const d = await r.json();
        if (d['Global Quote']?.['05. price']) {
          price = parseFloat(d['Global Quote']['05. price']).toFixed(2);
          change = parseFloat(d['Global Quote']['09. change']).toFixed(2);
          changePct = parseFloat(d['Global Quote']['10. change percent'].replace('%', '')).toFixed(2);
          volume = parseInt(d['Global Quote']['06. volume']).toLocaleString();
          high = parseFloat(d['Global Quote']['03. high']).toFixed(2);
          low = parseFloat(d['Global Quote']['04. low']).toFixed(2);
        }
      } catch (e) {
        console.error("Price fetch error:", e.message);
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

    const pct = changePct ? parseFloat(changePct) : 0;
    const technicals = calculateTechnicalSignals({ price, high, low }, pct);
    const sentiment = analyzeNewsSentiment(news, ticker);
    
    let score = 50;
    if (pct > 10) score += 20;
    else if (pct > 5) score += 15;
    else if (pct > 2) score += 10;
    else if (pct > 0) score += 5;
    else if (pct > -2) score -= 5;
    else if (pct > -5) score -= 10;
    else if (pct > -10) score -= 15;
    else score -= 20;
    
    if (news.length >= 3) score += 15;
    else if (news.length >= 2) score += 10;
    else if (news.length >= 1) score += 5;
    
    score += (sentiment.score - 50) / 5;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const prompt = `You're a financial analyst providing educational market context for ${ticker} stock.

CURRENT MARKET DATA:
- Price: $${price} (${changePct}% ${change >= 0 ? 'up' : 'down'} today)
- Day Range: $${low} - $${high}  
- Volume: ${volume}
${news.length ? `\nRECENT FINANCIAL NEWS:\n${news.map(n => `• ${n.source} (${n.time}h ago): ${n.title}`).join('\n')}` : '\n• Minimal financial news coverage in past 72 hours'}

Write a focused 4-section analysis (90 words). Use EXACT numbered format:

1. MARKET CONTEXT
Explain TODAY's specific price movement for ${ticker}. What's happening with THIS COMPANY right now?

2. KEY WATCHPOINTS  
List 2-3 specific metrics/factors investors track for ${ticker}'s business. Use bullet points (•).

3. RISK CONSIDERATIONS
Identify 1-2 specific risks for ${ticker} at current valuation. Use bullet points (•).

4. RESEARCH CHECKLIST
One actionable sentence: what should investors verify about ${ticker} before position sizing?

RULES:
- Be SPECIFIC to ${ticker}
- Use plain text, NO markdown
- Third-person only
- Start each section with "1.", "2.", "3.", "4."`;

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
    let aiAnalysis = aiData.choices?.[0]?.message?.content || "";

    const headerBadge = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:rgba(15,15,15,0.95);border-bottom:1px solid rgba(46,185,224,0.15);font-size:10px;">
        <span style="color:#888;">🤖 AI-Enhanced Research Tool</span>
        <span style="color:#666;">General Information • Not Advice</span>
      </div>
    `;

    const priceCard = price ? `
      <div style="background:linear-gradient(135deg,rgba(15,15,15,0.95),rgba(25,25,35,0.95));border:1px solid rgba(46,185,224,0.2);border-radius:12px;padding:20px;margin:16px 0;backdrop-filter:blur(10px);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Current Price</div>
            <div style="font-size:32px;font-weight:700;color:#fff;line-height:1;">$${price}</div>
          </div>
          <div style="text-align:right;">
            <div style="display:inline-block;padding:6px 12px;background:${change >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'};border:1px solid ${change >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'};border-radius:6px;">
              <div style="font-size:18px;font-weight:700;color:${change >= 0 ? '#10b981' : '#ef4444'};">${change >= 0 ? '+' : ''}$${change}</div>
              <div style="font-size:13px;font-weight:600;color:${change >= 0 ? '#10b981' : '#ef4444'};">${change >= 0 ? '+' : ''}${changePct}%</div>
            </div>
          </div>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">HIGH</div>
            <div style="font-size:14px;font-weight:600;color:#10b981;">$${high}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">LOW</div>
            <div style="font-size:14px;font-weight:600;color:#ef4444;">$${low}</div>
          </div>
          <div>
            <div style="font-size:10px;color:#666;margin-bottom:4px;">VOLUME</div>
            <div style="font-size:14px;font-weight:600;color:#3b82f6;">${volume}</div>
          </div>
        </div>
      </div>
    ` : '';

    const signalsSection = `
      <div style="margin:16px 0;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">⚡ Market Signals</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div style="padding:12px;background:rgba(${sentiment.color === '#10b981' ? '16,185,129' : sentiment.color === '#ef4444' ? '239,68,68' : '107,114,128'},0.1);border:1px solid rgba(${sentiment.color === '#10b981' ? '16,185,129' : sentiment.color === '#ef4444' ? '239,68,68' : '107,114,128'},0.25);border-radius:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:4px;">NEWS SENTIMENT</div>
            <div style="font-size:16px;font-weight:700;color:${sentiment.color};">${sentiment.label}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;">${sentiment.score}/100</div>
          </div>
          <div style="padding:12px;background:rgba(46,185,224,0.1);border:1px solid rgba(46,185,224,0.25);border-radius:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:4px;">MARKET INTEREST</div>
            <div style="font-size:16px;font-weight:700;color:#2eb9e0;">${score > 60 ? 'Elevated' : score > 40 ? 'Moderate' : 'Below Avg'}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;">${score}/100</div>
          </div>
        </div>
        ${technicals.length ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
          ${technicals.map(t => `<span style="font-size:11px;padding:4px 10px;background:rgba(${t.color === '#10b981' ? '16,185,129' : t.color === '#ef4444' ? '239,68,68' : '245,158,11'},0.15);border:1px solid rgba(${t.color === '#10b981' ? '16,185,129' : t.color === '#ef4444' ? '239,68,68' : '245,158,11'},0.3);border-radius:20px;color:${t.color};">📊 ${t.text}</span>`).join('')}
        </div>` : ''}
      </div>
    `;

    const newsSection = news.length ? `
      <div style="margin:16px 0;">
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
      </div>
    ` : `
      <div style="margin:16px 0;padding:16px;background:rgba(107,114,128,0.08);border:1px dashed rgba(107,114,128,0.2);border-radius:8px;text-align:center;">
        <div style="font-size:13px;color:#888;">📭 No major news in past 48 hours</div>
      </div>
    `;

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
    
    const formattedAnalysis = sections.length >= 3 ? `
      <div style="margin:16px 0;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">💡 Professional Context</div>
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
      <div style="margin:20px 0;padding:16px;background:linear-gradient(135deg,rgba(102,126,234,0.08),rgba(118,75,162,0.08));border:1px solid rgba(102,126,234,0.2);border-radius:10px;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">🎯 Common Next Steps</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#667eea;">□</span> Review SEC filings
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#667eea;">□</span> Compare to peers
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#667eea;">□</span> Check earnings date
          </div>
          <div style="padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;color:#d0d0d0;">
            <span style="color:#667eea;">□</span> Verify fundamentals
          </div>
        </div>
      </div>
    `;

    const footerDisclaimer = `
      <div style="margin-top:20px;padding:12px;background:rgba(0,0,0,0.4);border-top:1px solid rgba(255,255,255,0.05);border-radius:0 0 12px 12px;font-size:10px;line-height:1.5;color:#666;text-align:center;">
        <div style="margin-bottom:4px;">
          <span style="color:#fbbf24;">⚠️</span> <strong style="color:#888;">Educational research tool</strong> • General market information only
        </div>
        <div>
          Not personalized advice • Always conduct your own due diligence
        </div>
      </div>
    `;

    const fullResponse = headerBadge + priceCard + signalsSection + newsSection + formattedAnalysis + actionPanel + footerDisclaimer;

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
  console.log(`   ${OPENROUTER_KEY ? '✓' : '✗'} OpenRouter (AI Analysis)`);
  console.log(`   ${NEWS_KEY ? '✓' : '✗'} NewsAPI (Headlines)`);
  console.log(`   ${PRICE_KEY ? '✓' : '✗'} Alpha Vantage (Price Data)`);
  console.log(`\n🔒 Legal Framework: Active`);
  console.log(`   ✓ Educational framing`);
  console.log(`   ✓ Non-prescriptive language`);
  console.log(`   ✓ Proper disclaimers`);
  console.log(`   ✓ Mechanical scoring\n`);
});
