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
                
                const last30Closes = k.close.slice(-30);
                const avgPrice = last30Closes.reduce((a, b) => a + b) / 30;
                const variance = last30Closes.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / 30;
                const volatility = Math.sqrt(variance) / avgPrice;

                let adTrend = 0;
                for (let i = k.time.length - 20; i < k.time.length; i++) {
                    const mfMultiplier = ((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001);
                    adTrend += mfMultiplier * k.vol[i];
                }

                // MOVEMENT DATA
                const last30Highs = k.high;
                const last30Lows = k.low;
                const peakPrice = Math.max(...last30Highs);
                const floorPrice = Math.min(...last30Lows);
                const peakIdx = last30Highs.lastIndexOf(peakPrice);
                const daysSincePeak = k.time.length - 1 - peakIdx;
                
                const totalPumpSize = ((peakPrice - floorPrice) / floorPrice) * 100;
                const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;

                // LOGIC FOR MODES
                const isExtremeVol = volCurrent > (volAvg * 2.5);
                const isPump = (daysSincePeak <= 20 && totalPumpSize >= 50); // Specifically 50%+
                const isCorrection = (isPump && dropFromPeak >= 20); // Dropped at least 20% from peak

                let status = "NEUTRAL", color = "#888", explanation = "No clear footprint.";
                
                if (mode === 'correction' && isCorrection) {
                    const isShort = adTrend < 0;
                    status = isShort ? "🚨 SHORT CANDIDATE" : "🍀 DIP BUY OPPORTUNITY";
                    color = isShort ? "#ff4444" : "#00ff88";
                    explanation = isShort ? "Structure failure. Whales are dumping into the drop. Target lower." : "Healthy retrace. Whales are absorbing the dip for leg 2.";
                } else if (mode === 'extreme' && isExtremeVol) {
                    status = adTrend > 0 ? "🚨 EXTREME BUYING" : "🚨 EXTREME SELLING";
                    color = adTrend > 0 ? "#00ff88" : "#ff4444";
                    explanation = `Vol Surge: ${(volCurrent/volAvg).toFixed(1)}x above average.`;
                } else if (mode === 'pump' && daysSincePeak <= 20 && totalPumpSize >= 15) {
                    status = "🚀 20D HIGH"; color = "#d400ff";
                    explanation = `Momentum: Hit high ${daysSincePeak} days ago.`;
                } else if (volatility < 0.045 && adTrend > 0) {
                    status = "💎 ACCUMULATION"; color = "#10b981";
                    explanation = "Whale absorption. Coiled for breakout.";
                } else if (volatility < 0.045 && adTrend < 0) {
                    status = "⚠️ DISTRIBUTION"; color = "#ef4444";
                    explanation = "Whale offloading. Fake base detected.";
                }

                const matchesMode = (mode === 'correction' && isCorrection) || (mode === 'acc' && status.includes("ACC")) || (mode === 'dist' && status.includes("DIST")) || (mode === 'pump' && status.includes("20D")) || (mode === 'extreme' && isExtremeVol) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round((Math.max(0, 40 - (volatility * 800))) + (Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5)) + (Math.min(20, (volCurrent / volAvg) * 5)));
                    const riskBuffer = volatility * 1.5;

                    results.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status, color, price: currentPrice, adScore: Math.round(adTrend),
                        strength: Math.max(10, Math.min(100, strength)),
                        explanation,
                        modeData: {
                            isCorrection, drop: dropFromPeak.toFixed(1) + "%", pump: totalPumpSize.toFixed(0) + "%",
                            isExtreme: isExtremeVol, volPower: (volCurrent / volAvg).toFixed(1) + "x",
                            isPump: (daysSincePeak <= 20 && totalPumpSize >= 15) && !isCorrection, peak: daysSincePeak
                        },
                        plan: { 
                            entry: currentPrice.toFixed(4), 
                            stop: (adTrend < 0) ? (currentPrice * (1 + riskBuffer)).toFixed(4) : (currentPrice * (1 - riskBuffer)).toFixed(4),
                            tp1: (adTrend < 0) ? (currentPrice * (1 - riskBuffer * 2)).toFixed(4) : (currentPrice * (1 + riskBuffer * 2)).toFixed(4),
                            tp2: (adTrend < 0) ? (currentPrice * (1 - riskBuffer * 5)).toFixed(4) : (currentPrice * (1 + riskBuffer * 5)).toFixed(4)
                        }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}