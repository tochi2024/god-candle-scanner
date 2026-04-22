const axios = require('axios');

// These headers make the request look like it's coming from a real Google Chrome browser
const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.bybit.com/'
};

export default async function handler(req, res) {
    try {
        // 1. Get Symbols with Browser Headers
        const exchangeRes = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear', {
            headers: browserHeaders
        });

        const symbols = exchangeRes.data.result.list
            .filter(s => s.quoteCoin === 'USDT' && s.status === 'Trading')
            .map(s => s.symbol)
            .slice(0, 15); // Scans 15 coins to stay safe

        const candidates = [];

        for (const symbol of symbols) {
            try {
                // Fetch Candles
                const klineRes = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=30`, {
                    headers: browserHeaders
                });
                
                const klines = klineRes.data.result.list;
                const closes = klines.map(k => parseFloat(k[4])).reverse();
                const volumes = klines.map(k => parseFloat(k[5])).reverse();

                const last10 = closes.slice(-10);
                const avg = last10.reduce((a, b) => a + b) / 10;
                const variance = last10.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                const avgVol = volumes.reduce((a, b) => a + b) / 30;
                const currentVol = volumes[29];

                if (volatility < 0.04) {
                    candidates.push({
                        symbol,
                        volatility: (volatility * 100).toFixed(2) + "%",
                        volumeAlert: currentVol > avgVol * 1.3 ? "🔥 HIGH ABSORPTION" : "💤 QUIET",
                        price: closes[29]
                    });
                }
                
                // Small sleep to avoid 403 rate limits
                await new Promise(r => setTimeout(r, 100));

            } catch (e) {
                continue; // Skip if one coin fails
            }
        }

        res.status(200).json(candidates);
    } catch (err) {
        console.error("Main Error:", err.message);
        res.status(500).json({ error: "Access Denied (403). Try changing Vercel Region." });
    }
}