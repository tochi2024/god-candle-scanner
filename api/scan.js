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
                // Use 1-hour candles for 'steady' mode, 1-day for others
                const interval = mode === 'steady' ? 'Min60' : 'Day1';
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=50`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 35) return;

                const currentPrice = k.close[k.close.length - 1];
                const lastCloses = k.close;
                
                // --- NEW STEADY TREND LOGIC (10-30 Hours) ---
                if (mode === 'steady') {
                    let trendType = null;
                    let hours = 0;

                    // Check for Steady Fall from High
                    const recentHigh = Math.max(...k.high.slice(-40));
                    const highIdx = k.high.lastIndexOf(recentHigh);
                    const fallDuration = (k.time.length - 1) - highIdx;

                    // Check for Steady Rise from Low
                    const recentLow = Math.min(...k.low.slice(-40));
                    const lowIdx = k.low.lastIndexOf(recentLow);
                    const riseDuration = (k.time.length - 1) - lowIdx;

                    if (fallDuration >= 10 && fallDuration <= 30) {
                        // Verify if price is actually lower than the high and moving down
                        if (currentPrice < recentHigh) {
                            trendType = "STEADY FALL";
                            hours = fallDuration;
                        }
                    } else if (riseDuration >= 10 && riseDuration <= 30) {
                        if (currentPrice > recentLow) {
                            trendType = "STEADY RISE";
                            hours = riseDuration;
                        }
                    }

                    if (trendType) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: `📉 ${trendType}`,
                            color: trendType.includes("RISE") ? "#00e5ff" : "#ffab00",
                            price: currentPrice,
                            steadyHours: hours,
                            explanation: `Trend Analysis: Token has been moving ${trendType.split(' ')[1].toLowerCase()} for ${hours} consecutive hours since its local extreme.`,
                            // Default empty plan to avoid errors in UI
                            plan: { entry: currentPrice.toFixed(4), stop: "0", tp1: "0", tp2: "0" },
                            modeData: { isSteady: true }
                        });
                    }
                    return;
                }

                // --- ALL PREVIOUS FUNCTIONS (ACC/DIST/PUMP/EXTREME) REMAIN UNTOUCHED ---
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

                const last30Highs = k.high;
                const peakPrice = Math.max(...last30Highs);
                const floorPrice = Math.min(...k.low);
                const peakIdx = last30Highs.lastIndexOf(peakPrice);
                const daysSincePeak = k.time.length - 1 - peakIdx;
                const totalPumpSize = ((peakPrice - floorPrice) / floorPrice) * 100;
                const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;

                const isExtremeVol = volCurrent > (volAvg * 2.5);
                const isFlat = volatility < 0.045;
                const isAcc = (isFlat && adTrend > 0);
                const isDist = (isFlat && adTrend < 0);
                const isPump = (daysSincePeak <= 20 && totalPumpSize >= 15);
                const isCorrection = (totalPumpSize >= 50 && dropFromPeak >= 20);

                let status = "NEUTRAL", color = "#888", explanation = "Market is balanced.";

                if (mode === 'correction' && isCorrection) {
                    status = adTrend < 0 ? "🚨 SHORT CANDIDATE" : "🍀 DIP BUY OPPORTUNITY";
                    color = adTrend < 0 ? "#ff4444" : "#00ff88";
                    explanation = adTrend < 0 ? "Structure failure. Whales dumping." : "Healthy retrace. Whales absorbing.";
                } else if (mode === 'extreme' && isExtremeVol) {
                    status = adTrend > 0 ? "🚨 EXTREME BUYING" : "🚨 EXTREME SELLING";
                    color = adTrend > 0 ? "#00ff88" : "#ff4444";
                    explanation = `Vol Surge: ${(volCurrent/volAvg).toFixed(1)}x above average.`;
                } else if (mode === 'pump' && isPump) {
                    status = "🚀 20D HIGH"; color = "#d400ff";
                    explanation = `Momentum: Hit high ${daysSincePeak} days ago.`;
                } else if (isAcc) {
                    status = "💎 ACCUMULATION"; color = "#10b981";
                    explanation = "Whale absorption detected.";
                } else if (isDist) {
                    status = "⚠️ DISTRIBUTION"; color = "#ef4444";
                    explanation = "Whale offloading detected.";
                }

                const matchesMode = (mode === 'acc' && isAcc) || (mode === 'dist' && isDist) || (mode === 'pump' && isPump) || (mode === 'extreme' && isExtremeVol) || (mode === 'correction' && isCorrection) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round((Math.max(0, 40 - (volatility * 800))) + (Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5)) + (Math.min(20, (volCurrent / volAvg) * 5)));
                    const riskBuffer = volatility * 1.5;
                    results.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status, color, price: currentPrice, adScore: Math.round(adTrend),
                        strength: Math.max(10, Math.min(100, strength)),
                        explanation,
                        modeData: { isCorrection, drop: dropFromPeak.toFixed(1) + "%", pump: totalPumpSize.toFixed(0) + "%", isExtreme: isExtremeVol, volPower: (volCurrent / volAvg).toFixed(1) + "x", isPump, peak: daysSincePeak },
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