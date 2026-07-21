const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol, mode, start = 0, end = 50 } = req.query;
        
        const tickerRes = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
        const tickers = tickerRes.data.data;

        // Global Liquidity Filter: 400k+
        const qualifiedSymbols = tickers
            .filter(s => s.symbol.endsWith('_USDT') && parseFloat(s.amount24) >= 400000)
            .map(s => s.symbol);

        let targetSymbols = manualSymbol 
            ? [(manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT')]
            : qualifiedSymbols.slice(parseInt(start), parseInt(end));

        const results = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const tickerInfo = tickers.find(t => t.symbol === symbol);
                const currentVolumeUSDT = tickerInfo ? parseFloat(tickerInfo.amount24).toLocaleString() : "N/A";

                // Interval logic: 5m for surges, 1h for steady, 1d for macro
                let interval = 'Day1';
                if (mode === 'steady') interval = 'Min60';
                if (mode === 'vsurge') interval = 'Min5';

                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=100`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 30) return;

                const currentPrice = k.close[k.close.length - 1];

                // --- NEW: V-SURGE LOGIC (-5% to +10% within 2 Hours) ---
                if (mode === 'vsurge') {
                    const windowSize = 24; // 24 * 5 mins = 120 mins (2 hours)
                    const windowCloses = k.close.slice(-windowSize);
                    const startPrice = windowCloses[0];
                    
                    const minPrice = Math.min(...windowCloses);
                    const minIndex = windowCloses.indexOf(minPrice);
                    
                    // We only look for the max price occurring AFTER the min price
                    const pricesAfterMin = windowCloses.slice(minIndex);
                    const maxPriceAfterMin = Math.max(...pricesAfterMin);

                    const dropFromStart = ((minPrice - startPrice) / startPrice) * 100;
                    const riseFromStart = ((maxPriceAfterMin - startPrice) / startPrice) * 100;

                    if (dropFromStart <= -5 && riseFromStart >= 10) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: "⚡ V-SURGE RECOVERY",
                            color: "#ff0055",
                            price: currentPrice,
                            vSurgeData: { drop: dropFromStart.toFixed(1) + "%", rise: riseFromStart.toFixed(1) + "%" },
                            vol24h: currentVolumeUSDT,
                            explanation: `Bear Trap Alert: Token dropped ${dropFromStart.toFixed(1)}% and rocketed to +${riseFromStart.toFixed(1)}% within 2 hours.`,
                            plan: { entry: currentPrice.toFixed(4), stop: "N/A", tp1: "N/A", tp2: "N/A" },
                            modeData: { isVSurge: true }
                        });
                    }
                    return;
                }

                // --- STEADY TREND LOGIC ---
                if (mode === 'steady') {
                    const highs = k.high.slice(-40);
                    const lows = k.low.slice(-40);
                    const maxHigh = Math.max(...highs);
                    const minLow = Math.min(...lows);
                    const hrsSincePeak = (highs.length - 1) - highs.lastIndexOf(maxHigh);
                    const hrsSinceFloor = (lows.length - 1) - lows.lastIndexOf(minLow);
                    let type = null, duration = 0;
                    if (hrsSincePeak >= 10 && hrsSincePeak <= 30 && currentPrice <= Math.min(...k.low.slice(highs.lastIndexOf(maxHigh))) * 1.005) { type = "STEADY FALL"; duration = hrsSincePeak; }
                    if (!type && hrsSinceFloor >= 10 && hrsSinceFloor <= 30 && currentPrice >= Math.max(...k.high.slice(lows.lastIndexOf(minLow))) * 0.995) { type = "STEADY RISE"; duration = hrsSinceFloor; }
                    if (type) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''), status: type, color: type.includes("RISE") ? "#00e5ff" : "#ffab00",
                            price: currentPrice, steadyHours: duration, vol24h: currentVolumeUSDT, explanation: `Steady ${type.toLowerCase()} for ${duration}h.`,
                            plan: { entry: currentPrice.toFixed(4), stop: "N/A", tp1: "N/A", tp2: "N/A" },
                            modeData: { isSteady: true }
                        });
                    }
                    return;
                }

                // --- MACRO MODES (ACC/DIST/PUMP) ---
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
                const daysPeak = k.time.length - 1 - last30Highs.lastIndexOf(peak);
                const incMacro = ((peak - Math.min(...k.low)) / Math.min(...k.low)) * 100;
                const isFlat = volatility < 0.045;
                const isAcc = (isFlat && adTrend > 0);
                const isDist = (isFlat && adTrend < 0);
                const isPump = (daysPeak <= 20 && incMacro >= 15);
                const isExt = volCurrent > (volAvg * 2.5);

                let status = "NEUTRAL", color = "#888";
                if (mode === 'extreme' && isExt) { status = adTrend > 0 ? "🚨 EXTREME BUYING" : "🚨 EXTREME SELLING"; color = adTrend > 0 ? "#00ff88" : "#ff4444"; }
                else if (mode === 'pump' && isPump) { status = "🚀 20D HIGH"; color = "#d400ff"; }
                else if (isAcc) { status = "💎 ACCUMULATION"; color = "#10b981"; }
                else if (isDist) { status = "⚠️ DISTRIBUTION"; color = "#ef4444"; }

                const matchesMode = (mode === 'acc' && isAcc) || (mode === 'dist' && isDist) || (mode === 'pump' && isPump) || (mode === 'extreme' && isExt) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round((Math.max(0, 40 - (volatility * 800))) + (Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5)) + (Math.min(20, (volCurrent / volAvg) * 5)));
                    const risk = volatility * 1.5;
                    results.push({
                        symbol: symbol.replace('_USDT', ''), volatility: (volatility * 100).toFixed(2) + "%", status, color, price: currentPrice, adScore: Math.round(adTrend), strength: Math.max(10, Math.min(100, strength)), explanation: "Macro analysis.", vol24h: currentVolumeUSDT,
                        modeData: { isPump, peakDay: daysPeak },
                        plan: { entry: currentPrice.toFixed(4), stop: status.includes("DIST") ? (currentPrice * (1 + risk)).toFixed(4) : (currentPrice * (1 - risk)).toFixed(4), tp1: status.includes("DIST") ? (currentPrice * (1 - risk * 2)).toFixed(4) : (currentPrice * (1 + risk * 2)).toFixed(4), tp2: status.includes("DIST") ? (currentPrice * (1 - risk * 5)).toFixed(4) : (currentPrice * (1 + risk * 5)).toFixed(4) }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}