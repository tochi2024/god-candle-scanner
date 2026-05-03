const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, mode, start = 0, end = 50 } = req.query;
        
        // 1. Get real-time ticker data to filter by 24h Volume
        const tickerRes = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
        const tickers = tickerRes.data.data;

        // 2. Filter for USDT pairs with Volume >= 600,000 USDT
        // s.amount24 represents the 24h trading value in USDT
        const qualifiedSymbols = tickers
            .filter(s => s.symbol.endsWith('_USDT') && parseFloat(s.amount24) >= 600000)
            .map(s => s.symbol);

        // Define the search pool from the high-liquidity list
        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : qualifiedSymbols.slice(parseInt(start), parseInt(end));

        const results = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                // Find the specific ticker data for this symbol to display volume
                const tickerInfo = tickers.find(t => t.symbol === symbol);
                const currentVolumeUSDT = parseFloat(tickerInfo.amount24).toLocaleString();

                const interval = mode === 'steady' ? 'Min60' : 'Day1';
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=100`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 50) return;

                const currentPrice = k.close[k.close.length - 1];

                // --- STEADY TREND LOGIC (1H Chart) ---
                if (mode === 'steady') {
                    const highs = k.high.slice(-40);
                    const lows = k.low.slice(-40);
                    const maxHigh = Math.max(...highs);
                    const minLow = Math.min(...lows);
                    const highIdx = highs.lastIndexOf(maxHigh);
                    const lowIdx = lows.lastIndexOf(minLow);
                    const hrsSincePeak = (highs.length - 1) - highIdx;
                    const hrsSinceFloor = (lows.length - 1) - lowIdx;

                    let type = null;
                    let duration = 0;

                    if (hrsSincePeak >= 10 && hrsSincePeak <= 30) {
                        const lowestSincePeak = Math.min(...lows.slice(highIdx));
                        if (currentPrice <= lowestSincePeak * 1.005) { type = "STEADY FALL"; duration = hrsSincePeak; }
                    }
                    if (!type && hrsSinceFloor >= 10 && hrsSinceFloor <= 30) {
                        const highestSinceFloor = Math.max(...highs.slice(lowIdx));
                        if (currentPrice >= highestSinceFloor * 0.995) { type = "STEADY RISE"; duration = hrsSinceFloor; }
                    }

                    if (type) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: type,
                            color: type.includes("RISE") ? "#00e5ff" : "#ffab00",
                            price: currentPrice,
                            steadyHours: duration,
                            vol24h: currentVolumeUSDT,
                            explanation: `Market moved from extreme ${duration} hours ago. Volume is healthy at $${currentVolumeUSDT}.`,
                            volatility: "1H Trend", adScore: "N/A", strength: 85,
                            plan: { entry: currentPrice.toFixed(4), stop: "N/A", tp1: "N/A", tp2: "N/A" },
                            modeData: { isSteady: true }
                        });
                    }
                    return;
                }

                // --- OTHER MODES (ACC/DIST/PUMP/EXTREME) ---
                const last30 = k.close.slice(-30);
                const avg = last30.reduce((a, b) => a + b) / 30;
                const volatility = Math.sqrt(last30.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 30) / avg;
                let adTrend = 0;
                for (let i = k.time.length - 20; i < k.time.length; i++) {
                    adTrend += (((k.close[i] - k.low[i]) - (k.high[i] - k.close[i])) / (k.high[i] - k.low[i] || 0.0001)) * k.vol[i];
                }
                const volAvg = k.vol.reduce((a, b) => a + b) / 30;
                const volCurrent = k.vol[k.vol.length - 1];
                const last30Highs = k.high;
                const peak = Math.max(...last30Highs);
                const peakIdx = last30Highs.lastIndexOf(peak);
                const daysPeak = k.time.length - 1 - peakIdx;
                const incMacro = ((peak - Math.min(...k.low)) / Math.min(...k.low)) * 100;
                
                const isExt = volCurrent > (volAvg * 2.5);
                const isFlat = volatility < 0.045;
                const isAcc = (isFlat && adTrend > 0);
                const isDist = (isFlat && adTrend < 0);
                const isPump = (daysPeak <= 20 && incMacro >= 15);
                const isCorr = (incMacro >= 50 && ((peak - currentPrice) / peak) * 100 >= 20);

                let status = "NEUTRAL", color = "#888", expl = "Balanced.";
                if (mode === 'extreme' && isExt) { status = adTrend > 0 ? "🚨 EXTREME BUYING" : "🚨 EXTREME SELLING"; color = adTrend > 0 ? "#00ff88" : "#ff4444"; expl = "Massive Whale activity."; }
                else if (mode === 'correction' && isCorr) { status = adTrend < 0 ? "🚨 SHORT CANDIDATE" : "🍀 DIP BUY"; color = adTrend < 0 ? "#ff4444" : "#00ff88"; expl = "Correction phase."; }
                else if (mode === 'pump' && isPump) { status = "🚀 20D HIGH"; color = "#d400ff"; expl = "Momentum peak hit."; }
                else if (isAcc) { status = "💎 ACCUMULATION"; color = "#10b981"; expl = "Whale absorption."; }
                else if (isDist) { status = "⚠️ DISTRIBUTION"; color = "#ef4444"; expl = "Whale offloading."; }

                const matchesMode = (mode === 'acc' && isAcc) || (mode === 'dist' && isDist) || (mode === 'pump' && isPump) || (mode === 'extreme' && isExt) || (mode === 'correction' && isCorr) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round((Math.max(0, 40 - (volatility * 800))) + (Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5)) + (Math.min(20, (volCurrent / volAvg) * 5)));
                    const risk = volatility * 1.5;
                    results.push({
                        symbol: symbol.replace('_USDT', ''), volatility: (volatility * 100).toFixed(2) + "%", status, color, price: currentPrice, adScore: Math.round(adTrend), strength: Math.max(10, strength), explanation: expl, vol24h: currentVolumeUSDT,
                        modeData: { isPump, increase: incMacro.toFixed(1) + "%", peakDay: daysPeak, isExtreme: isExt, volPower: (volCurrent / volAvg).toFixed(1) + "x", isCorrection: isCorr, drop: (((peak-currentPrice)/peak)*100).toFixed(1)+"%", pump: incMacro.toFixed(0)+"%" },
                        plan: { entry: currentPrice.toFixed(4), stop: status.includes("DIST") ? (currentPrice * (1 + risk)).toFixed(4) : (currentPrice * (1 - risk)).toFixed(4), tp1: status.includes("DIST") ? (currentPrice * (1 - risk * 2)).toFixed(4) : (currentPrice * (1 + risk * 2)).toFixed(4), tp2: status.includes("DIST") ? (currentPrice * (1 - risk * 5)).toFixed(4) : (currentPrice * (1 + risk * 5)).toFixed(4) }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}