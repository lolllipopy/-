const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');

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

// ====== СТАТИЧЕСКИЕ ФАЙЛЫ ======
app.use(express.static(path.join(__dirname)));

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/room/:id', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ====== ПАРСИНГ REZKA ======

// Поиск фильмов
app.get('/api/rezka/search', async function (req, res) {
    try {
        const q = req.query.q;
        const r = await fetchRezka(`${REZKA_BASE}/search/?do=search&subaction=search&q=${encodeURIComponent(q)}`);
        const html = await r.text();

        const films = [];
        // Правильный паттерн для rezka.fi
        const regex = /<div[^>]*class="b-content__inline_item"[^>]*data-url="([^"]+)"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<div[^>]*class="b-content__inline_item-link"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi;

        let match;
        while ((match = regex.exec(html)) !== null && films.length < 10) {
            films.push({
                url: match[1],
                title: match[3].trim(),
                poster: match[2]
            });
        }

        res.json(films);
    } catch (e) {
        console.error('Search error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Получение информации о фильме + переводы
app.get('/api/rezka/info', async function (req, res) {
    try {
        const url = req.query.url;
        const r = await fetchRezka(url);
        const html = await r.text();

        // Парсим переводы через data-translator_id
        const allTranslators = [];
        const transRegex = /data-translator_id="(\d+)"[^>]*>([^<]+)</gi;
        let tm;
        while ((tm = transRegex.exec(html)) !== null) {
            if (!allTranslators.find(t => t.id === tm[1])) {
                allTranslators.push({
                    id: tm[1],
                    name: tm[2].trim()
                });
            }
        }

        // Фильтруем только нужные озвучки
        const allowedNames = ['Дубляж', 'LostFilm', 'HDrezka в Кубе', 'Kubik³', 'Оригинал', 'Red Head Sound'];
        const translators = allTranslators.filter(t => {
            const lower = t.name.toLowerCase();
            return allowedNames.some(a => lower.includes(a.toLowerCase()));
        });

        console.log('All translators:', allTranslators.map(t => t.name));
        console.log('Filtered translators:', translators.map(t => t.name));

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
        console.error('Info error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Получение потоков с конкретным переводом
app.get('/api/rezka/stream', async function (req, res) {
    try {
        const url = req.query.url;
        const translatorId = req.query.translator || '1';
        const quality = req.query.quality || '720p';

        console.log('Stream request:', { url: url ? url.substring(0, 50) : 'empty', translatorId, quality });

        if (!url) {
            return res.status(400).json({ error: 'No URL provided' });
        }

        const r = await fetchRezka(url);
        const html = await r.text();

        // Ищем news_id для AJAX запроса
        // На rezka.fi news_id = ID из URL (например, /films/action/1483-... → 1483)
        let newsId = '';
        const urlIdMatch = url.match(/\/(\d+)-[^/]+\.html$/);
        if (urlIdMatch) {
            newsId = urlIdMatch[1];
        } else {
            // Fallback: ищем в HTML
            const newsIdMatch = html.match(/news_id\s*[:=]\s*(\d+)/) || html.match(/id:\s*(\d+)/);
            if (newsIdMatch) newsId = newsIdMatch[1];
        }

        console.log('News ID:', newsId);

        let streams = {};
        let title = '';

        // Пробуем получить через AJAX API
        if (newsId) {
            try {
                const ajaxUrl = `${REZKA_BASE}/ajax/get_cdn_series/`;
                const formData = new URLSearchParams();
                formData.append('id', newsId);
                formData.append('translator_id', translatorId);
                formData.append('action', 'get_movie');

                console.log('AJAX request:', { id: newsId, translator_id: translatorId });

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
                console.log('AJAX response success:', ajaxData.success);

                if (ajaxData.success && ajaxData.url) {
                    const rawUrl = ajaxData.url;
                    console.log('Raw URL length:', rawUrl.length);

                    // Парсим формат [360p]url1 or url2[480p]url3...
                    const parts = rawUrl.split(/\[(\d+p)\]/).filter(Boolean);
                    console.log('Parsed parts count:', parts.length);

                    for (let i = 0; i < parts.length; i += 2) {
                        const q = parts[i];
                        if (i + 1 < parts.length) {
                            const urls = parts[i + 1].split(' or ').map(u => u.trim()).filter(Boolean);
                            console.log(`Quality ${q}:`, urls.length, 'URLs');
                            streams[q] = urls;
                        }
                    }
                } else {
                    console.log('AJAX failed:', ajaxData.message || 'no url');
                }

                if (ajaxData.title) title = ajaxData.title;
            } catch (ajaxErr) {
                console.log('AJAX error:', ajaxErr.message);
            }
        }

        console.log('Available qualities:', Object.keys(streams));

        // Фильтруем по запрошенному качеству
        const availableQualities = Object.keys(streams).sort((a, b) => parseInt(b) - parseInt(a));
        const selectedQuality = availableQualities.includes(quality) ? quality : (availableQualities[0] || '');

        const resultUrl = streams[selectedQuality] ? streams[selectedQuality][0] : '';
        console.log('Selected quality:', selectedQuality, 'URL:', resultUrl ? resultUrl.substring(0, 80) : 'none');

        res.json({
            title,
            description: '',
            streams,
            selectedQuality,
            availableQualities,
            url: resultUrl
        });
    } catch (e) {
        console.error('Stream error:', e);
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

        // Базовый URL для относительных путей
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

        // Заменяем ссылки на прокси (абсолютные и относительные)
        const proxyHost = 'https://' + req.get('host');
        content = content.replace(/^(?!#)(.+)$/gm, (match) => {
            const trimmed = match.trim();
            if (!trimmed) return match;

            // Если уже абсолютный URL
            if (trimmed.startsWith('http')) {
                return `${proxyHost}/api/rezka/proxy.ts?url=${encodeURIComponent(trimmed)}`;
            }

            // Если относительный путь (./ или просто имя файла)
            let absoluteUrl;
            if (trimmed.startsWith('./')) {
                absoluteUrl = baseUrl + trimmed.substring(2);
            } else if (trimmed.startsWith('/')) {
                // Относительно домена
                const domain = url.match(/^(https?:\/\/[^/]+)/);
                absoluteUrl = (domain ? domain[1] : '') + trimmed;
            } else {
                absoluteUrl = baseUrl + trimmed;
            }

            return `${proxyHost}/api/rezka/proxy.ts?url=${encodeURIComponent(absoluteUrl)}`;
        });

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
