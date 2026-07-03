const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);

app.use(express.json());

// CORS
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ====== REZKA АВТОРИЗАЦИЯ ======
const REZKA_BASE = 'https://rezka.fi';
const REZKA_COOKIES = process.env.DLE_USER_ID && process.env.DLE_PASSWORD
    ? `dle_user_id=${process.env.DLE_USER_ID}; dle_password=${process.env.DLE_PASSWORD}`
    : 'dle_user_id=2036888; dle_password=43b61691b91bf79becc08d15634f3a04';

console.log('Auth cookies:', REZKA_COOKIES ? 'loaded' : 'not set');

async function fetchRezka(url, opts = {}) {
    const r = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': REZKA_BASE,
            'Cookie': REZKA_COOKIES,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            ...opts.headers
        },
        ...opts
    });
    return r;
}

// ====== ПАРСИНГ REZKA ======

// Поиск фильмов
app.get('/api/rezka/search', async function (req, res) {
    try {
        const q = req.query.q;
        const r = await fetchRezka(`${REZKA_BASE}/search/?do=search&subaction=search&q=${encodeURIComponent(q)}`);
        const html = await r.text();

        const films = [];
        // Паттерн для результатов поиска
        const regex = /<a href="(\/films\/[^"]+|\/series\/[^"]+|\/cartoons\/[^"]+)"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/gi;

        let match;
        while ((match = regex.exec(html)) !== null && films.length < 10) {
            films.push({
                url: REZKA_BASE + match[1],
                title: match[3].trim(),
                poster: match[2]
            });
        }

        // Альтернативный паттерн если первый не сработал
        if (films.length === 0) {
            const altRegex = /<a href="(\/films\/[^"]+|\/series\/[^"]+)"[^>]*>[^<]*<span[^>]*>([^<]+)<\/span>/gi;
            while ((match = altRegex.exec(html)) !== null && films.length < 10) {
                films.push({
                    url: REZKA_BASE + match[1],
                    title: match[2].trim(),
                    poster: ''
                });
            }
        }

        res.json(films);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получение информации о фильме + переводы
app.get('/api/rezka/info', async function (req, res) {
    try {
        const url = req.query.url;
        const r = await fetchRezka(url);
        const html = await r.text();

        // Парсим переводы
        const translators = [];
        const transMatch = html.match(/<ul[^>]*id="translators-list"[^>]*>([\s\S]*?)<\/ul>/);
        if (transMatch) {
            const transHtml = transMatch[1];
            const transRegex = /<li[^>]*data-translator_id="(\d+)"[^>]*>([^<]+)<\/li>/gi;
            let tm;
            while ((tm = transRegex.exec(transHtml)) !== null) {
                translators.push({
                    id: tm[1],
                    name: tm[2].trim()
                });
            }
        }

        // Если нет списка переводов, проверяем другие паттерны
        if (translators.length === 0) {
            const altRegex = /data-translator_id="(\d+)"[^>]*>([^<]+)</gi;
            let tm;
            while ((tm = altRegex.exec(html)) !== null) {
                if (!translators.find(t => t.id === tm[1])) {
                    translators.push({
                        id: tm[1],
                        name: tm[2].trim()
                    });
                }
            }
        }

        // Заголовок
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // Описание
        const descMatch = html.match(/<div[^>]*class="b-post__description_text"[^>]*>([\s\S]*?)<\/div>/);
        const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';

        // Постер
        const posterMatch = html.match(/<img[^>]*class="b-post__img[^"]*"[^>]*src="([^"]+)"/);
        const poster = posterMatch ? posterMatch[1] : '';

        // Проверяем, является ли это сериалом
        const isSeries = html.includes('b-simple_seasons') || html.includes('b-post__series') || html.includes('seasons');

        res.json({
            title,
            description,
            poster,
            isSeries,
            translators: translators.length > 0 ? translators : [{id: '1', name: 'Оригинал'}]
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получение потоков с конкретным переводом
app.get('/api/rezka/stream', async function (req, res) {
    try {
        const url = req.query.url;
        const translatorId = req.query.translator || '1';
        const quality = req.query.quality || '720p';

        const r = await fetchRezka(url);
        const html = await r.text();

        // Ищем news_id для AJAX запроса
        const newsIdMatch = html.match(/news_id\s*:\s*(\d+)/) || html.match(/id:\s*(\d+)/);
        const newsId = newsIdMatch ? newsIdMatch[1] : '';

        let streams = {};

        // Пробуем получить через AJAX API
        if (newsId) {
            try {
                const ajaxUrl = `${REZKA_BASE}/ajax/get_cdn_series/`;
                const formData = new URLSearchParams();
                formData.append('id', newsId);
                formData.append('translator_id', translatorId);
                formData.append('action', 'get_movie');

                const ajaxR = await fetch(ajaxUrl, {
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': url,
                        'Cookie': REZKA_COOKIES,
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: formData.toString()
                });

                const ajaxData = await ajaxR.json();
                if (ajaxData.success && ajaxData.url) {
                    // Декодируем URL
                    const decoded = Buffer.from(ajaxData.url, 'base64').toString('utf8');
                    // Парсим качества
                    const qualityRegex = /\[(\d+p)\]([^\[]+)\[\/\]/g;
                    let qm;
                    while ((qm = qualityRegex.exec(decoded)) !== null) {
                        streams[qm[1]] = qm[2].split(',').map(s => s.trim().split(' or ')[0]).filter(Boolean);
                    }
                }
            } catch (ajaxErr) {
                console.log('AJAX failed, falling back to inline:', ajaxErr.message);
            }
        }

        // Fallback: парсим inline streams
        if (Object.keys(streams).length === 0) {
            const cdnMatch = html.match(/streams":"([^"]+)"/);
            if (cdnMatch) {
                try {
                    const decoded = Buffer.from(cdnMatch[1], 'base64').toString('utf8');
                    const qualityRegex = /\[(\d+p)\]([^\[]+)\[\/\]/g;
                    let qm;
                    while ((qm = qualityRegex.exec(decoded)) !== null) {
                        streams[qm[1]] = qm[2].split(',').map(s => s.trim().split(' or ')[0]).filter(Boolean);
                    }
                } catch (e) {
                    console.log('Decode failed:', e.message);
                }
            }
        }

        // Фильтруем по запрошенному качеству
        const availableQualities = Object.keys(streams).sort((a, b) => parseInt(b) - parseInt(a));
        const selectedQuality = availableQualities.includes(quality) ? quality : (availableQualities[0] || '720p');

        res.json({
            title: '',
            description: '',
            streams: streams,
            selectedQuality,
            availableQualities,
            url: streams[selectedQuality] ? streams[selectedQuality][0] : ''
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Прокси HLS плейлиста
app.get('/api/rezka/proxy.m3u8', async function (req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send('No URL');

        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': REZKA_BASE,
                'Cookie': REZKA_COOKIES
            }
        });

        let content = await r.text();

        // Заменяем ссылки на прокси
        content = content.replace(/^(?!#)(https?:\/\/.+)$/gm, 
            (match) => `${req.protocol}://${req.get('host')}/api/rezka/proxy.ts?url=${encodeURIComponent(match)}`);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(content);
    } catch (e) {
        res.status(500).send('Error: ' + e.message);
    }
});

// Прокси TS сегментов
app.get('/api/rezka/proxy.ts', async function (req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send('No URL');

        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': REZKA_BASE,
                'Cookie': REZKA_COOKIES
            }
        });

        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache');
        r.body.pipe(res);
    } catch (e) {
        res.status(500).send('Error: ' + e.message);
    }
});


// ====== КОМНАТЫ ======
const rooms = new Map();

function generateRoomId() {
    return crypto.randomBytes(4).toString('hex');
}

function createRoom() {
    const id = generateRoomId();
    rooms.set(id, {
        host: null,
        guests: [],
        state: {
            url: '',
            isPlaying: false,
            time: 0,
            updatedAt: 0,
            title: '',
            poster: '',
            filmUrl: '',
            translatorId: '1',
            translatorName: 'Оригинал',
            quality: '720p'
        },
        createdAt: Date.now()
    });
    return id;
}

function getRoom(id) {
    return rooms.get(id);
}

function cleanupRooms() {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (now - room.createdAt > 24 * 60 * 60 * 1000) {
            rooms.delete(id);
        }
    }
}
setInterval(cleanupRooms, 60000);


// ====== API КОМНАТ ======

app.post('/api/room/create', function (req, res) {
    const id = createRoom();
    res.json({ roomId: id, url: `/room/${id}` });
});

app.get('/api/room/:id', function (req, res) {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });

    const now = Date.now();
    const hostOnline = room.host && (now - room.host.lastPing) < 10000;

    res.json({
        state: room.state,
        hostOnline: hostOnline,
        guestCount: room.guests.length,
        createdAt: room.createdAt
    });
});

app.get('/api/room/:id/stream', function (req, res) {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const guestId = crypto.randomBytes(4).toString('hex');
    const guest = { id: guestId, res: res };
    room.guests.push(guest);

    res.write('data: ' + JSON.stringify({
        type: 'state',
        data: room.state
    }) + '\n\n');

    req.on('close', function () {
        room.guests = room.guests.filter(g => g.id !== guestId);
    });
});

app.post('/api/room/:id/host', function (req, res) {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });

    const body = req.body;

    if (!room.host) {
        room.host = { id: crypto.randomBytes(4).toString('hex'), lastPing: Date.now() };
    }

    room.host.lastPing = Date.now();

    if (body.url !== undefined) room.state.url = body.url;
    if (body.isPlaying !== undefined) room.state.isPlaying = body.isPlaying;
    if (body.time !== undefined) room.state.time = body.time;
    if (body.title !== undefined) room.state.title = body.title;
    if (body.poster !== undefined) room.state.poster = body.poster;
    if (body.filmUrl !== undefined) room.state.filmUrl = body.filmUrl;
    if (body.translatorId !== undefined) room.state.translatorId = body.translatorId;
    if (body.translatorName !== undefined) room.state.translatorName = body.translatorName;
    if (body.quality !== undefined) room.state.quality = body.quality;
    if (body.action) room.state.action = body.action;
    room.state.updatedAt = Date.now();

    const data = 'data: ' + JSON.stringify({
        type: 'state',
        data: room.state
    }) + '\n\n';

    room.guests.forEach(function (g) {
        try { g.res.write(data); } catch (e) {}
    });

    res.json({ ok: true, hostId: room.host.id });
});

app.post('/api/room/:id/ping', function (req, res) {
    const room = getRoom(req.params.id);
    if (!room || !room.host) return res.status(404).json({ error: 'no host' });

    room.host.lastPing = Date.now();
    if (req.body.time !== undefined) room.state.time = req.body.time;
    if (req.body.isPlaying !== undefined) room.state.isPlaying = req.body.isPlaying;

    res.json({ ok: true });
});

setInterval(function () {
    for (const room of rooms.values()) {
        room.guests.forEach(function (g) {
            try { g.res.write(': ping\n\n'); } catch (e) {}
        });
    }
}, 25000);


// ====== СТАРЫЕ ЭНДПОИНТЫ (совместимость) ======
const SECRET = 'pizba2025';
let globalState = {
    url: '',
    isPlaying: false,
    time: 0,
    updatedAt: 0,
    adminOnline: false,
    lastAdminPing: 0,
};
let globalClients = [];

app.get('/api/stream', function (req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('data: ' + JSON.stringify(globalState) + '\n\n');
    globalClients.push(res);
    req.on('close', function () {
        globalClients = globalClients.filter(c => c !== res);
    });
});

app.post('/api/state', function (req, res) {
    if (req.headers['x-secret'] !== SECRET) return res.status(403).json({ error: 'forbidden' });
    const body = req.body;
    if (body.action === 'ping') {
        globalState.lastAdminPing = Date.now();
        globalState.adminOnline = true;
        globalState.time = body.time || globalState.time;
        globalState.isPlaying = body.isPlaying !== undefined ? body.isPlaying : globalState.isPlaying;
    } else {
        globalState = Object.assign(globalState, body, { updatedAt: Date.now(), lastAdminPing: globalState.lastAdminPing });
    }
    const data = 'data: ' + JSON.stringify(globalState) + '\n\n';
    globalClients.forEach(c => c.write(data));
    res.json({ ok: true });
});

app.get('/api/viewers', function (req, res) {
    res.json({ count: globalClients.length });
});

app.get('/api/state', function (req, res) {
    res.json(globalState);
});

app.get('/api/event', function (req, res) {
    res.json({ title: 'Пизба 2', desc: 'Синхронный просмотр', images: [] });
});


const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', function () {
    console.log('Server running on port ' + PORT);
});
