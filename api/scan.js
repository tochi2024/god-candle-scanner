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

                let interval = 'Day1';
                if (mode === 'steady') interval = 'Min60';
                if (mode === 'vsurge') interval = 'Min5';

                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${interval}&limit=120`, { timeout: 6000 });
                const k = klineRes.data.data;
                if (!k || k.time.length < 30) return;

                const currentPrice = k.close[k.close.length - 1];

                // --- V-SURGE: OPTIMIZED ZONE CROSSOVER (-3% to +6%) ---
                if (mode === 'vsurge') {
                    const windowSize = 24; // 2 hours
                    const windowCloses = k.close.slice(-windowSize);
                    const windowLows = k.low.slice(-windowSize);
                    
                    const startPrice = windowCloses[0]; 
                    const absoluteMin = Math.min(...windowLows);
                    
                    const negativeDiff = ((absoluteMin - startPrice) / startPrice) * 100;
                    const positiveDiff = ((currentPrice - startPrice) / startPrice) * 100;

                    // Criteria: Hit -3% zone, recovered to +6% zone relative to 2hrs ago
                    if (negativeDiff <= -3 && positiveDiff >= 6) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''),
                            status: "⚡ ZONE CROSSOVER",
                            color: "#ff0055",
                            price: currentPrice,
                            vSurgeData: { 
                                start: startPrice.toFixed(4),
                                neg: negativeDiff.toFixed(1) + "%", 
                                pos: positiveDiff.toFixed(1) + "%" 
                            },
                            vol24h: currentVolumeUSDT,
                            explanation: `Reversal: Reference Price $${startPrice.toFixed(4)}. Dropped to ${negativeDiff.toFixed(1)}% zone and surged to +${positiveDiff.toFixed(1)}% zone.`,
                            volatility: "5M Analysis", adScore: "Reversal", strength: 90,
                            plan: { entry: currentPrice.toFixed(4), stop: startPrice.toFixed(4), tp1: (currentPrice * 1.05).toFixed(4), tp2: (currentPrice * 1.12).toFixed(4) },
                            modeData: { isVSurge: true }
                        });
                    }
                    return;
                }

                // --- ALL OTHER MODES REMAIN UNCHANGED ---
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

                if (mode === 'steady') {
                    const h_s = k.high.slice(-40); const l_s = k.low.slice(-40);
                    const hrsPeak = (h_s.length - 1) - h_s.lastIndexOf(Math.max(...h_s));
                    const hrsFloor = (l_s.length - 1) - l_s.lastIndexOf(Math.min(...l_s));
                    let type = null, dur = 0;
                    if (hrsPeak >= 10 && hrsPeak <= 30 && currentPrice <= Math.min(...k.low.slice(h_s.lastIndexOf(Math.max(...h_s)))) * 1.005) { type = "STEADY FALL"; dur = hrsPeak; }
                    if (!type && hrsFloor >= 10 && hrsFloor <= 30 && currentPrice >= Math.max(...k.high.slice(l_s.lastIndexOf(Math.min(...l_s)))) * 0.995) { type = "STEADY RISE"; dur = hrsFloor; }
                    if (type) {
                        results.push({
                            symbol: symbol.replace('_USDT', ''), status: type, color: type.includes("RISE") ? "#00e5ff" : "#ffab00",
                            price: currentPrice, steadyHours: dur, vol24h: currentVolumeUSDT, explanation: `Steady trend for ${dur}h.`,
                            plan: { entry: currentPrice.toFixed(4), stop: "N/A", tp1: "N/A", tp2: "N/A" }, modeData: { isSteady: true }, strength: 85, volatility: "1H Analysis", adScore: "N/A"
                        });
                    }
                    return;
                }

                let status = "NEUTRAL", color = "#888";
                const isExt = volCurrent > (volAvg * 2.5);
                if (mode === 'extreme' && isExt) { status = adTrend > 0 ? "🚨 EXTREME BUYING" : "🚨 EXTREME SELLING"; color = adTrend > 0 ? "#00ff88" : "#ff4444"; }
                else if (mode === 'pump' && daysPeak <= 20 && incMacro >= 15) { status = "🚀 20D HIGH"; color = "#d400ff"; }
                else if (volatility < 0.045 && adTrend > 0) { status = "💎 ACCUMULATION"; color = "#10b981"; }
                else if (volatility < 0.045 && adTrend < 0) { status = "⚠️ DISTRIBUTION"; color = "#ef4444"; }

                const matchesMode = (mode === 'acc' && status.includes("ACC")) || (mode === 'dist' && status.includes("DIST")) || (mode === 'pump' && status.includes("20D")) || (mode === 'extreme' && isExt) || (!mode);

                if (manualSymbol || (status !== "NEUTRAL" && matchesMode)) {
                    let strength = Math.round((Math.max(0, 40 - (volatility * 800))) + (Math.min(40, (Math.abs(adTrend) / (volAvg || 1)) * 5)) + (Math.min(20, (volCurrent / volAvg) * 5)));
                    results.push({
                        symbol: symbol.replace('_USDT', ''), volatility: (volatility * 100).toFixed(2) + "%", status, color, price: currentPrice, adScore: Math.round(adTrend), strength: Math.max(10, Math.min(100, strength)), explanation: "Macro analysis.", vol24h: currentVolumeUSDT,
                        modeData: { isPump: status.includes("20D"), peakDay: daysPeak },
                        plan: { 
                            entry: currentPrice.toFixed(4), 
                            stop: status.includes("DIST") ? (currentPrice * (1.05)).toFixed(4) : (currentPrice * 0.95).toFixed(4),
                            tp1: status.includes("DIST") ? (currentPrice * 0.90).toFixed(4) : (currentPrice * 1.10).toFixed(4),
                            tp2: status.includes("DIST") ? (currentPrice * 0.80).toFixed(4) : (currentPrice * 1.25).toFixed(4)
                        }
                    });
                }
            } catch (e) {}
        }));
        res.status(200).json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
}