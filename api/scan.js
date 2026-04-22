const axios = require('axios');

export default async function handler(req, res) {
    try {
        // 1. Get List of Binance Futures pairs
        const { data: exchangeInfo } = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const symbols = exchangeInfo.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol)
            .slice(0, 30); // Scanning 30 pairs to stay under Vercel's 10s limit

        const candidates = [];

        for (const symbol of symbols) {
            // 2. Get last 30 days of price data
            const { data: klines } = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`);
            
            const closes = klines.map(k => parseFloat(k[4]));
            const volumes = klines.map(k => parseFloat(k[5]));

            // 3. Logic: Volatility Compression (Standard Deviation)
            const last10Days = closes.slice(-10);
            const avg = last10Days.reduce((a, b) => a + b) / 10;
            const variance = last10Days.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
            const volatility = Math.sqrt(variance) / avg;

            // 4. Logic: Volume Lead-In (Current vol > avg vol)
            const avgVol = volumes.reduce((a, b) => a + b) / 30;
            const currentVol = volumes[29];

            // If volatility is low (< 3%), it's "Coiling"
            if (volatility < 0.03) {
                candidates.push({
                    symbol,
                    volatility: (volatility * 100).toFixed(2) + "%",
                    volumeAlert: currentVol > avgVol * 1.3 ? "🔥 HIGH ABSORPTION" : "💤 QUIET",
                    price: closes[29]
                });
            }
        }

        res.status(200).json(candidates);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
}