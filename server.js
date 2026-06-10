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

let clients = [];

function currentState() {
    return Object.assign({}, state, { adminOnline: (Date.now() - state.lastAdminPing) < 5000 });
}

function pushToClients() {
    var data = 'data: ' + JSON.stringify(currentState()) + '\n\n';
    clients.forEach(function (res) { res.write(data); });
}

// SSE — зрители подключаются сюда и сразу получают обновления
app.get('/api/stream', function (req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write('data: ' + JSON.stringify(currentState()) + '\n\n');

    clients.push(res);

    req.on('close', function () {
        clients = clients.filter(function (c) { return c !== res; });
    });
});

// Heartbeat каждые 25с — не даёт Render закрыть соединение
setInterval(function () {
    clients.forEach(function (res) { res.write(': ping\n\n'); });
}, 25000);

// Проверка adminOnline каждые 2с — зрители узнают когда админ ушёл
setInterval(function () {
    var online = (Date.now() - state.lastAdminPing) < 5000;
    if (online !== state.adminOnline) {
        state.adminOnline = online;
        pushToClients();
    }
}, 2000);

app.get('/api/viewers', function (req, res) {
    res.json({ count: clients.length });
});

app.get('/api/state', function (req, res) {
    res.json(currentState());
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
    pushToClients();
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', function () {
    console.log('Server running on port ' + PORT);
});
