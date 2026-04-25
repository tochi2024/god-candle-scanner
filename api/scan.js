const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, mode, start = 0, end = 40 } = req.query;
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        const gemZone = allSymbols.slice(50, 800);
        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : gemZone.slice(parseInt(start), parseInt(end));

        const results = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1&limit=30`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 8) return;

                const currentPrice = k.close[k.close.length - 1];

                // --- PUMP HUNT LOGIC (STRICT 50%+) ---
                if (mode === 'pump') {
                    const last7Highs = k.high.slice(-7);
                    const startPrice = k.open[k.open.length - 7]; 
                    const peakPrice = Math.max(...last7Highs);
                    
                    const increasePct = ((peakPrice - startPrice) / startPrice) * 100;

                    if (increasePct >= 50) { // CHANGED TO 50
                        const peakIdx = last7Highs.lastIndexOf(peakPrice);
                        const peakTs = k.time[k.time.length - 7 + peakIdx] * 1000;

                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: "🔥 50%+ PUMP DETECTED",
                            color: "#d400ff",
                            price: currentPrice,
                            increase: increasePct.toFixed(2) + "%",
                            peakTime: new Date(peakTs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' }),
                            explanation: `Strong Momentum: This token surged ${increasePct.toFixed(0)}% from its 7-day low. Peak hit on ${new Date(peakTs).toLocaleDateString()}.`
                        });
                    }
                    return; 
                }

                // --- REGULAR ACC/DIST LOGIC ---
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

                let strength = 0;
                strength += Math.max(0, 40 - (volatility * 800)); 
                strength += Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5);
                strength += Math.min(20, (volCurrent / volAvg) * 5);
                const finalStrength = Math.round(Math.min(100, strength));

                const isFlat = volatility < 0.045;
                const isAcc = (isFlat && adTrend > 0);
                const isDist = (isFlat && adTrend < 0);
                const isSpike = (volCurrent > volAvg * 1.5);

                let status = "NEUTRAL", color = "#888", explanation = "No clear footprint.";
                if (isAcc) { status = "💎 ACCUMULATION"; color = "#10b981"; explanation = "Whale absorption. High probability breakout."; }
                else if (isDist) { status = "⚠️ DISTRIBUTION"; color = "#ef4444"; explanation = "Whale offloading. High probability breakdown."; }
                else if (isSpike) { status = "🔥 VOLUME SPIKE"; color = "#f59e0b"; explanation = "Massive momentum surge."; }

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
                        explanation, strength: finalStrength,
                        plan: { entry: currentPrice.toFixed(4), stop: stopLoss.toFixed(4), tp1: tp1.toFixed(4), tp2: tp2.toFixed(4) }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}