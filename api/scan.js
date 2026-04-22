const axios = require('axios');

export default async function handler(req, res) {
    try {
        // 1. Get Binance Futures pairs
        const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const symbols = response.data.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol)
            .slice(0, 10); // Start with 10 to ensure it works

        const candidates = [];

        // 2. Scan them (Using Promise.all makes it 10x faster)
        await Promise.all(symbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`);
                const klines = klineRes.data;
                
                const closes = klines.map(k => parseFloat(k[4]));
                const volumes = klines.map(k => parseFloat(k[5]));

                // Volatility Logic
                const last10Days = closes.slice(-10);
                const avg = last10Days.reduce((a, b) => a + b) / 10;
                const variance = last10Days.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                const avgVol = volumes.reduce((a, b) => a + b) / 30;
                const currentVol = volumes[29];

                if (volatility < 0.05) { // 5% threshold
                    candidates.push({
                        symbol,
                        volatility: (volatility * 100).toFixed(2) + "%",
                        volumeAlert: currentVol > avgVol * 1.2 ? "🔥 HIGH ABSORPTION" : "💤 QUIET",
                        price: closes[29]
                    });
                }
            } catch (e) {
                // Skip coins that fail to fetch
            }
        }));

        res.status(200).json(candidates);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
}