const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol } = req.query;
        
        // 1. Get all MEXC Futures symbols
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        // Define our range: High-cap (0-100) and Mid-cap (101-300)
        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : allSymbols.slice(0, 300); // Expanded to 300 tokens

        const results = [];

        // 2. Helper function for parallel processing to avoid Vercel Timeout
        const processBatch = async (batch) => {
            return Promise.all(batch.map(async (symbol) => {
                try {
                    const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`, { timeout: 3000 });
                    const k = klineRes.data.data;
                    if (!k || k.time.length < 30) return null;

                    const last30Closes = k.close.slice(-30);
                    const avgPrice = last30Closes.reduce((a, b) => a + b) / 30;
                    const variance = last30Closes.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / 30;
                    const volatility = Math.sqrt(variance) / avgPrice;

                    // A/D (Accumulation/Distribution) Money Flow Logic
                    let adTrend = 0;
                    for (let i = k.time.length - 20; i < k.time.length; i++) {
                        const mfMultiplier = ((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001);
                        adTrend += mfMultiplier * k.vol[i];
                    }

                    const isFlat = volatility < 0.045;
                    const volSpike = k.vol[k.vol.length - 1] > (k.vol.reduce((a, b) => a + b) / 30) * 1.4;

                    let status = "NEUTRAL";
                    let color = "#888";
                    
                    if (adTrend > 0 && isFlat) { status = "💎 ACCUMULATION"; color = "#00ff88"; }
                    else if (adTrend < 0 && isFlat) { status = "⚠️ DISTRIBUTION"; color = "#ff4444"; }
                    else if (volSpike) { status = "🔥 VOLUME SPIKE"; color = "#ffaa00"; }

                    if (manualSymbol || status !== "NEUTRAL") {
                        return {
                            symbol: symbol.replace('_USDT', ''),
                            volatility: (volatility * 100).toFixed(2) + "%",
                            status,
                            color,
                            price: k.close[k.close.length - 1],
                            adScore: Math.round(adTrend)
                        };
                    }
                } catch (e) { return null; }
            }));
        };

        // 3. Run in Parallel Chunks of 50 to maximize speed
        for (let i = 0; i < targetSymbols.length; i += 50) {
            const batch = targetSymbols.slice(i, i + 50);
            const batchResults = await processBatch(batch);
            results.push(...batchResults.filter(r => r !== null));
        }

        res.status(200).json(results);
    } catch (err) {
        res.status(500).json({ error: "Scanner Timeout or API Error: " + err.message });
    }
}