const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, start = 0, end = 50 } = req.query;
        
        // 1. Get all MEXC Futures symbols
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        // 2. DEFINE THE GEM ZONE (Skip top 50, take next 350)
        const gemZoneSymbols = allSymbols.slice(50, 400);

        let targetSymbols = [];
        if (manualSymbol) {
            const formatted = manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT';
            targetSymbols = [formatted];
        } else {
            // Take the specific chunk requested by the frontend from the Gem Zone
            targetSymbols = gemZoneSymbols.slice(parseInt(start), parseInt(end));
        }

        const results = [];

        // 3. Parallel scan for speed
        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`, { timeout: 5000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 30) return;

                const last30Closes = k.close.slice(-30);
                const avgPrice = last30Closes.reduce((a, b) => a + b) / 30;
                const variance = last30Closes.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / 30;
                const volatility = Math.sqrt(variance) / avgPrice;

                let adTrend = 0;
                for (let i = k.time.length - 20; i < k.time.length; i++) {
                    const mfMultiplier = ((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001);
                    adTrend += mfMultiplier * k.vol[i];
                }

                const volAvg = k.vol.reduce((a, b) => a + b) / 30;
                const volCurrent = k.vol[k.vol.length - 1];
                const isFlat = volatility < 0.045;
                const volSpike = volCurrent > volAvg * 1.5;

                let status = "NEUTRAL";
                let color = "#888";
                let explanation = "Market is in balance. No clear whale footprint detected.";

                if (isFlat && adTrend > 0) {
                    status = "💎 ACCUMULATION";
                    color = "#10b981";
                    explanation = volatility < 0.025 
                        ? "ULTRA-TIGHT SQUEEZE. Whales are aggressively capping the price while filling bags. Extremely high breakout potential."
                        : "Steady whale absorption detected. Supply is being removed from the market while price stays stable.";
                } 
                else if (isFlat && adTrend < 0) {
                    status = "⚠️ DISTRIBUTION";
                    color = "#ef4444";
                    explanation = "Whales are quietly offloading positions into retail buy orders. Price is being held flat to prevent panic selling.";
                }
                else if (volSpike) {
                    status = "🔥 VOLUME SPIKE";
                    color = "#f59e0b";
                    explanation = "Sudden massive surge in activity. The 'Spring' is likely snapping. Watch for immediate momentum follow-through.";
                }
                else if (volatility < 0.02) {
                    explanation = "Price has completely flatlined. Maximum compression. Waiting for a volume trigger to decide the next big move.";
                }

                if (manualSymbol || status !== "NEUTRAL") {
                    results.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status,
                        color,
                        price: k.close[k.close.length - 1],
                        adScore: Math.round(adTrend),
                        explanation
                    });
                }
            } catch (e) {}
        }));

        res.status(200).json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}