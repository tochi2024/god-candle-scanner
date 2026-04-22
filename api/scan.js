const axios = require('axios');

export default async function handler(req, res) {
    try {
        // 1. Get List of Bybit Perpetual Pairs (Linear USDT)
        // Bybit doesn't block Vercel IPs, so 451 error is gone.
        const exchangeRes = await axios.get('https://api.bybit.com/v5/market/instruments-info?category=linear');
        const symbols = exchangeRes.data.result.list
            .filter(s => s.quoteCoin === 'USDT' && s.status === 'Trading')
            .map(s => s.symbol)
            .slice(0, 20); // Scanning 20 pairs to stay fast

        const candidates = [];

        // 2. Scan each coin for the RAVE pattern
        await Promise.all(symbols.map(async (symbol) => {
            try {
                // Fetch Daily Candles (Klines)
                const klineRes = await axios.get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=30`);
                const klines = klineRes.data.result.list; // Bybit returns newest first

                // We need 30 days of Close prices and Volume
                const closes = klines.map(k => parseFloat(k[4])).reverse();
                const volumes = klines.map(k => parseFloat(k[5])).reverse();

                // 3. Logic: Volatility Compression (Last 10 days)
                const last10 = closes.slice(-10);
                const avg = last10.reduce((a, b) => a + b) / 10;
                const variance = last10.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                // 4. Logic: Volume Absorption Check
                const avgVol = volumes.reduce((a, b) => a + b) / 30;
                const currentVol = volumes[29];

                // If volatility < 4%, it's a Coiled Spring
                if (volatility < 0.04) {
                    candidates.push({
                        symbol,
                        volatility: (volatility * 100).toFixed(2) + "%",
                        volumeAlert: currentVol > avgVol * 1.5 ? "🔥 HIGH ABSORPTION" : "💤 QUIET",
                        price: closes[29]
                    });
                }
            } catch (e) {
                // Skip failed symbols
            }
        }));

        res.status(200).json(candidates);
    } catch (err) {
        console.error("Main Error:", err.message);
        res.status(500).json({ error: "API connection failed. Bybit might be busy." });
    }
}