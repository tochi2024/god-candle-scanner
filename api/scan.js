const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, mode, start = 0, end = 50 } = req.query;
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        // Define the search zone (Starting from rank 50)
        const gemZone = allSymbols.slice(50, 800);

        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : gemZone.slice(parseInt(start), parseInt(end));

        const results = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`, { timeout: 5000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 30) return;

                const last30Closes = k.close.slice(-30);
                const currentPrice = k.close[k.close.length - 1];
                const avgPrice = last30Closes.reduce((a, b) => a + b) / 30;
                const variance = last30Closes.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / 30;
                const volatility = Math.sqrt(variance) / avgPrice;

                let adTrend = 0;
                for (let i = k.time.length - 20; i < k.time.length; i++) {
                    const mfMultiplier = ((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001);
                    adTrend += mfMultiplier * k.vol[i];
                }

                const isFlat = volatility < 0.045;
                const volAvg = k.vol.reduce((a, b) => a + b) / 30;
                const volCurrent = k.vol[k.vol.length - 1];

                let status = "NEUTRAL";
                let color = "#888";
                let explanation = "No clear footprint.";

                const isAcc = (isFlat && adTrend > 0);
                const isDist = (isFlat && adTrend < 0);
                const isSpike = (volCurrent > volAvg * 1.5);

                if (isAcc) {
                    status = "💎 ACCUMULATION";
                    color = "#10b981";
                    explanation = volatility < 0.025 ? "ULTRA-TIGHT SQUEEZE. Massive breakout potential." : "Steady whale absorption detected.";
                } else if (isDist) {
                    status = "⚠️ DISTRIBUTION";
                    color = "#ef4444";
                    explanation = "Whales offloading into retail bids. Bull trap likely.";
                } else if (isSpike) {
                    status = "🔥 VOLUME SPIKE";
                    color = "#f59e0b";
                    explanation = "High activity. Momentum is shifting rapidly.";
                }

                const matchesMode = (mode === 'acc' && isAcc) || (mode === 'dist' && isDist) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    const riskBuffer = volatility * 1.5;
                    const stopLoss = status === "⚠️ DISTRIBUTION" ? currentPrice * (1 + riskBuffer) : currentPrice * (1 - riskBuffer);
                    const tp1 = status === "⚠️ DISTRIBUTION" ? currentPrice * (1 - riskBuffer * 2) : currentPrice * (1 + riskBuffer * 2);
                    const tp2 = status === "⚠️ DISTRIBUTION" ? currentPrice * (1 - riskBuffer * 5) : currentPrice * (1 + riskBuffer * 5);

                    results.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status, color, price: currentPrice, adScore: Math.round(adTrend),
                        explanation,
                        plan: { entry: currentPrice.toFixed(4), stop: stopLoss.toFixed(4), tp1: tp1.toFixed(4), tp2: tp2.toFixed(4) }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}