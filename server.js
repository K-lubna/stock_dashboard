const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000; // Localhost port
const SUPPORTED_STOCKS = ['GOOG', 'TSLA', 'AMZN', 'META', 'NVDA'];
const HISTORY_LENGTH = 60; // Store 60 seconds of history for the graph

// --- Server State & Utility Functions ---

// In-memory price data
let currentPrices = SUPPORTED_STOCKS.reduce((acc, ticker) => {
    acc[ticker] = (Math.random() * 100) + 100; // Start between 100 and 200
    return acc;
}, {});

// In-memory price history
let priceHistory = SUPPORTED_STOCKS.reduce((acc, ticker) => {
    acc[ticker] = new Array(HISTORY_LENGTH).fill(currentPrices[ticker]); 
    return acc;
}, {});

function loadUsers() {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

        const filePath = path.join(dataDir, 'users.json');
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '[]', 'utf8');
            return [];
        }

        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error loading users.json:", error.message);
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(path.join(__dirname, 'data', 'users.json'), JSON.stringify(users, null, 4), 'utf8');
}

// --- Express Middleware & Routing ---

app.use(express.static('public')); 
app.use(express.json()); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- Registration ---
app.post('/api/register', (req, res) => {
    const { email } = req.body;
    const users = loadUsers();
    
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ success: false, message: 'User already exists.' });
    }

    const token = 'token' + Math.random().toString(36).substring(2, 9); 
    const newUser = { email, token, subscribedStocks: [] };
    users.push(newUser);
    saveUsers(users);

    res.json({ success: true, token, email, subscribedStocks: newUser.subscribedStocks, message: "Registration successful." });
});

// --- Login ---
app.post('/api/login', (req, res) => {
    const { email } = req.body;
    const users = loadUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found. Please register.' });
    }

    res.json({ success: true, token: user.token, email, subscribedStocks: user.subscribedStocks });
});

// --- Subscribe ---
app.post('/api/subscribe', (req, res) => {
    const { token, ticker } = req.body;
    const users = loadUsers();
    let user = users.find(u => u.token === token);

    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!SUPPORTED_STOCKS.includes(ticker)) return res.status(400).json({ success: false, message: 'Unsupported stock ticker.' });

    if (!user.subscribedStocks.includes(ticker)) {
        user.subscribedStocks.push(ticker);
        saveUsers(users);
    }
    
    res.json({ success: true, message: `${ticker} subscribed.`, currentPrice: currentPrices[ticker] });
});

// --- Unsubscribe ---
app.post('/api/unsubscribe', (req, res) => {
    const { token, ticker } = req.body;
    const users = loadUsers();
    let user = users.find(u => u.token === token);

    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const initialLength = user.subscribedStocks.length;
    user.subscribedStocks = user.subscribedStocks.filter(t => t !== ticker);

    if (user.subscribedStocks.length < initialLength) {
        saveUsers(users);
        res.json({ success: true, message: `${ticker} unsubscribed.` });
    } else {
        res.status(404).json({ success: false, message: 'Ticker not found in subscription list.' });
    }
});

// --- Price History ---
app.get('/api/history/:ticker', (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    if (priceHistory[ticker]) {
        res.json({ success: true, history: priceHistory[ticker] });
    } else {
        res.status(404).json({ success: false, message: 'Ticker history not found.' });
    }
});

// --- Recommendations ---
app.get('/api/recommendations', (req, res) => {
    const recs = [];
    const subscribed = loadUsers().find(u => u.token === req.query.token)?.subscribedStocks || [];
    const available = SUPPORTED_STOCKS.filter(t => !subscribed.includes(t));

    if (available.length > 0) {
        const recTicker = available[Math.floor(Math.random() * available.length)];
        recs.push({
            ticker: recTicker,
            signalType: 'BUY',
            reason: `Strong volume detected in ${recTicker}. Potential upward momentum.`
        });
    }

    res.json({ success: true, recommendations: recs });
});

// --- WebSocket ---
const clientSubscriptions = new Map(); 

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const token = urlParams.get('token');

    if (!token) {
        ws.close(1008, 'Token required for WebSocket connection.');
        return;
    }
    
    const users = loadUsers();
    const user = users.find(u => u.token === token);

    if (!user) {
        ws.close(1008, 'Invalid token.');
        return;
    }

    clientSubscriptions.set(ws, user.subscribedStocks);

    ws.on('close', () => clientSubscriptions.delete(ws));
});

// --- Price Update and Broadcast ---
function updateAndBroadcastPrices() {
    for (const ticker of SUPPORTED_STOCKS) {
        let current = currentPrices[ticker];
        const changeFactor = (Math.random() - 0.5) * 0.03; 
        let newPrice = current * (1 + changeFactor);
        if (newPrice < 1) newPrice = 1; 
        
        currentPrices[ticker] = newPrice;
        
        if (priceHistory[ticker].length >= HISTORY_LENGTH) priceHistory[ticker].shift();
        priceHistory[ticker].push(newPrice);

        const priceUpdateMessage = JSON.stringify({ ticker, price: newPrice.toFixed(2) });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                const subscribedTickers = clientSubscriptions.get(client);
                if (subscribedTickers && subscribedTickers.includes(ticker)) {
                    client.send(priceUpdateMessage);
                }
            }
        });
    }
}

setInterval(updateAndBroadcastPrices, 1000); 

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('API Endpoints: /api/login, /api/register, /api/subscribe, /api/unsubscribe, /api/history/:ticker, /api/recommendations');
    console.log(`WebSocket Server: ws://localhost:${PORT}`);
});
