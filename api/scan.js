const axios = require('axios');

export default async function handler(req, res) {
    try {
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        
        // Logic: Skip the first 20 coins (BTC, ETH, etc.) to find the "Hidden Gems"
        // Then take a random sample of 60 coins from the mid-cap list
        const allSymbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol);

        const targetSymbols = allSymbols.slice(20, 100); 

        const candidates = [];

        await Promise.all(targetSymbols.map(async (symbol) => {
            try {
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`);
                const klines = klineRes.data.data;

                if (!klines || klines.time.length < 20) return;

                const closes = klines.close;
                const volumes = klines.vol;

                // Tighter Volatility Logic: Look for "Flatline" (< 2.5% variation)
                const last10 = closes.slice(-10);
                const avg = last10.reduce((a, b) => a + b) / 10;
                const variance = last10.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                const avgVol = volumes.reduce((a, b) => a + b) / volumes.length;
                const currentVol = volumes[volumes.length - 1];

                // If volatility is extremely low, it's a candidate
                if (volatility < 0.025) { 
                    candidates.push({
                        symbol: symbol.replace('_USDT', ''),
                        mexcSymbol: symbol,
                        volatility: (volatility * 100).toFixed(2) + "%",
                        status: currentVol > avgVol * 1.2 ? "🔥 ACCUMULATION" : "💤 COILING",
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