const axios = require('axios');

export default async function handler(req, res) {
    try {
        const { symbol: manualSymbol } = req.query; // Check if user searched manually
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        let targetSymbols = [];
        
        if (manualSymbol) {
            // If manual search, only scan that specific symbol
            const formatted = manualSymbol.toUpperCase().endsWith('_USDT') ? manualSymbol.toUpperCase() : manualSymbol.toUpperCase() + '_USDT';
            targetSymbols = [formatted];
        } else {
            // Otherwise, scan a wider range of mid-caps (Tokens 20 to 170)
            targetSymbols = allSymbols.slice(20, 170); 
        }

        const candidates = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`);
                const klines = klineRes.data.data;
                if (!klines || klines.time.length < 20) return;

                const closes = klines.close;
                const volumes = klines.vol;

                const last10 = closes.slice(-10);
                const avg = last10.reduce((a, b) => a + b) / 10;
                const variance = last10.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                const avgVol = volumes.reduce((a, b) => a + b) / volumes.length;
                const currentVol = volumes[volumes.length - 1];

                // Loosened volatility to 4.5% so you see more results
                // But we tag them differently based on how "tight" they are
                if (volatility < 0.045 || manualSymbol) { 
                    candidates.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status: volatility < 0.025 ? "💎 PERFECT BASE" : "📈 COILING",
                        volumeAlert: currentVol > avgVol * 1.3 ? "🔥 ABSORPTION" : "💤 QUIET",
                        price: closes[closes.length - 1]
                    });
                }
            } catch (e) {}
        }));

        res.status(200).json(candidates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}