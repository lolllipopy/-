const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.json());

app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const SECRET = 'pizba2025';

let state = {
    url: '',
    isPlaying: false,
    time: 0,
    updatedAt: 0,
    adminOnline: false,
    lastAdminPing: 0,
};

app.get('/api/state', function (req, res) {
    state.adminOnline = (Date.now() - state.lastAdminPing) < 5000;
    res.json(state);
});

app.post('/api/state', function (req, res) {
    if (req.headers['x-secret'] !== SECRET) {
        return res.status(403).json({ error: 'forbidden' });
    }
    var body = req.body;
    if (body.action === 'ping') {
        state.lastAdminPing = Date.now();
        state.adminOnline = true;
        state.time = body.time || state.time;
        state.isPlaying = (body.isPlaying !== undefined) ? body.isPlaying : state.isPlaying;
    } else {
        state = Object.assign(state, body, { updatedAt: Date.now(), lastAdminPing: state.lastAdminPing });
    }
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', function () {
    console.log('Server running on port ' + PORT);
});
