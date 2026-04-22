const axios = require('axios');

export default async function handler(req, res) {
    try {
        // 1. Get MEXC Futures symbols (perpetual USDT pairs)
        const exchangeRes = await axios.get('https://contract.mexc.com/api/v1/contract/detail');
        
        // Filter for USDT pairs and take a sample to scan
        const symbols = exchangeRes.data.data
            .filter(s => s.quoteCoin === 'USDT' && s.state === 0)
            .map(s => s.symbol)
            .slice(0, 40); // Scans 40 coins

        const candidates = [];

        // 2. Fetch historical data for each
        await Promise.all(symbols.map(async (symbol) => {
            try {
                // MEXC Klines: interval 'Day1'
                const klineRes = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Day1`);
                const klines = klineRes.data.data;

                if (!klines || klines.time.length < 30) return;

                // Close prices and Volumes are in separate arrays in MEXC API
                const closes = klines.close;
                const volumes = klines.vol;

                // 3. Logic: Volatility (Last 10 Days)
                const last10 = closes.slice(-10);
                const avg = last10.reduce((a, b) => a + b) / 10;
                const variance = last10.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 10;
                const volatility = Math.sqrt(variance) / avg;

                // 4. Logic: Volume Lead-in
                const avgVol = volumes.reduce((a, b) => a + b) / volumes.length;
                const currentVol = volumes[volumes.length - 1];

                // FIND THE RAVE PATTERN: Low Volatility + Rising Volume
                if (volatility < 0.04) {
                    candidates.push({
                        symbol: symbol.replace('_USDT', ''),
                        volatility: (volatility * 100).toFixed(2) + "%",
                        volumeAlert: currentVol > avgVol * 1.5 ? "🔥 WHALE SPOTTED" : "💤 COILING",
                        price: closes[closes.length - 1],
                        link: `https://www.mexc.com/exchange/${symbol}`
                    });
                }
            } catch (e) {
                // Skip errors
            }
        }));

        res.status(200).json(candidates);
    } catch (err) {
        res.status(500).json({ error: "MEXC API is down or blocked. Error: " + err.message });
    }
}