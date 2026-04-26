const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, mode, start = 0, end = 50 } = req.query;
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        const gemZone = allSymbols.slice(50, 1550);
        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : gemZone.slice(parseInt(start), parseInt(end));

        const results = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1&limit=30`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 25) return;

                const currentPrice = k.close[k.close.length - 1];
                const volAvg = k.vol.reduce((a, b) => a + b) / 30;
                const volCurrent = k.vol[k.vol.length - 1];
                
                // Money Flow Logic
                let adTrend = 0;
                for (let i = k.time.length - 20; i < k.time.length; i++) {
                    const mfMultiplier = ((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001);
                    adTrend += mfMultiplier * k.vol[i];
                }

                // 1. EXTREME ACTIVITY LOGIC (Vol > 2.5x Avg)
                const isExtremeVol = volCurrent > (volAvg * 2.5);
                if (mode === 'extreme') {
                    if (isExtremeVol) {
                        const side = adTrend > 0 ? "BUYING" : "SELLING";
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: `🚨 EXTREME ${side}`,
                            color: adTrend > 0 ? "#00ff88" : "#ff4444",
                            price: currentPrice,
                            volPower: (volCurrent / volAvg).toFixed(1) + "x",
                            explanation: `Whale Alert: Volume is ${ (volCurrent / volAvg).toFixed(1) }x higher than normal with heavy ${side.toLowerCase()} pressure.`,
                            adScore: Math.round(adTrend)
                        });
                    }
                    return;
                }

                // 2. PUMP LOGIC (20D High)
                const last30Highs = k.high;
                const globalMaxHigh = Math.max(...last30Highs);
                const peakIndex = last30Highs.lastIndexOf(globalMaxHigh);
                const daysAgo = k.time.length - 1 - peakIndex;
                const increasePct = ((globalMaxHigh - Math.min(...k.low)) / Math.min(...k.low)) * 100;

                if (mode === 'pump') {
                    if (daysAgo <= 20 && increasePct >= 15) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: "🚀 NEW 20D HIGH",
                            color: "#d400ff",
                            price: currentPrice,
                            increase: increasePct.toFixed(2) + "%",
                            peakTime: new Date(k.time[peakIndex] * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric' }),
                            explanation: `Momentum: Hit a 20-day high ${daysAgo} days ago.`
                        });
                    }
                    return;
                }

                // 3. REGULAR ACC/DIST LOGIC
                const last30Closes = k.close.slice(-30);
                const avgPrice = last30Closes.reduce((a, b) => a + b) / 30;
                const variance = last30Closes.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / 30;
                const volatility = Math.sqrt(variance) / avgPrice;
                const isFlat = volatility < 0.045;

                let status = "NEUTRAL", color = "#888";
                if (isFlat && adTrend > 0) { status = "💎 ACCUMULATION"; color = "#10b981"; }
                else if (isFlat && adTrend < 0) { status = "⚠️ DISTRIBUTION"; color = "#ef4444"; }
                else if (volCurrent > volAvg * 1.5) { status = "🔥 VOLUME SPIKE"; color = "#f59e0b"; }

                const matchesMode = (mode === 'acc' && status.includes("ACC")) || (mode === 'dist' && status.includes("DIST")) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round(Math.min(100, (40 - (volatility * 800)) + ((Math.abs(adTrend) / (volAvg || 1)) * 5) + ((volCurrent / volAvg) * 5)));
                    const riskBuffer = volatility * 1.5;
                    results.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status, color, price: currentPrice, adScore: Math.round(adTrend),
                        strength: strength < 0 ? 10 : strength,
                        explanation: status.includes("ACC") ? "Whale absorption. Breakout likely." : "Distribution phase. Trap likely.",
                        plan: { 
                            entry: currentPrice.toFixed(4), 
                            stop: status.includes("DIST") ? (currentPrice * (1 + riskBuffer)).toFixed(4) : (currentPrice * (1 - riskBuffer)).toFixed(4),
                            tp1: status.includes("DIST") ? (currentPrice * (1 - riskBuffer * 2)).toFixed(4) : (currentPrice * (1 + riskBuffer * 2)).toFixed(4),
                            tp2: status.includes("DIST") ? (currentPrice * (1 - riskBuffer * 5)).toFixed(4) : (currentPrice * (1 + riskBuffer * 5)).toFixed(4)
                        }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}