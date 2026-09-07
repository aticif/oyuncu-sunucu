const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;
const REGION = process.env.REGION || 'local';  // ör: tokyo, istanbul, frankfurt
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '40', 10); // sunucu başına maksimum oyuncu

const server = http.createServer((req, res) => {
    const path = url.parse(req.url).pathname;

    // CORS başlıkları: tarayıcı başka domain'den sorgulayabilsin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    if (path === '/api/status' || path === '/status') {
        // Canlı oyuncu sayısı - sunucu tarayıcısı bunu çeker
        const total = totalPlayers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            region: REGION,
            players: total,
            maxPlayers: MAX_PLAYERS,
            status: total >= MAX_PLAYERS ? 'full' : 'online',
            ping: 0
        }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Space Shooter - Online Sunucu (${REGION}) Çalışıyor\n`);
});

const wss = new WebSocket.Server({ server });

// ===== ODA / OYUN DURUMU =====
const MAX_PLAYERS_PER_ROOM = 40; // tek odada maksimum
const rooms = new Map(); // roomId -> { players: Map, enemies: [], bullets: [], enemyBullets: [], wave, ... }

const TICK_RATE = 30; // sunucu tik/sn
const TICK_MS = 1000 / TICK_RATE;

function totalPlayers() {
    let total = 0;
    for (const r of rooms.values()) total += r.players.size;
    return total;
}

const ENEMY_TYPES = {
    scout: { hp: 20, speed: 6, score: 100, size: 1, color: 0xff4444 },
    fighter: { hp: 50, speed: 9, score: 250, size: 1.5, color: 0xff8800 },
    tank: { hp: 120, speed: 4, score: 500, size: 2.2, color: 0xaa2200 }
};

function createRoom(id) {
    rooms.set(id, {
        id,
        players: new Map(),
        enemies: [],
        bullets: [],
        enemyBullets: [],
        wave: 0,
        isBossWave: false,
        spawnQueue: [],
        spawnTimer: 1,
        started: false,
        usedColors: new Set()
    });
    return rooms.get(id);
}

// Her oyuncuya benzersiz bir renk ata
const AVAILABLE_COLORS = [0x00ccff, 0xff5544, 0x44ff66, 0xffcc33, 0xaa66ff, 0xff66cc, 0x00ffaa, 0xff9933];
function pickColor(room) {
    for (const c of AVAILABLE_COLORS) {
        if (!room.usedColors.has(c)) {
            room.usedColors.add(c);
            return c;
        }
    }
    const c = AVAILABLE_COLORS[room.players.size % AVAILABLE_COLORS.length];
    return c;
}

function getOrCreateRoom() {
    // En az dolu odanın öncelikli seçimi
    let best = null;
    for (const r of rooms.values()) {
        if (r.players.size < MAX_PLAYERS_PER_ROOM) {
            if (!best || r.players.size < best.players.size) best = r;
        }
    }
    if (!best) best = createRoom('oda-' + (rooms.size + 1) + '-' + Date.now());
    return best;
}

function playerJoin(ws, name) {
    // Sunucu genelinde maksimum oyuncu limiti
    if (totalPlayers() >= MAX_PLAYERS) {
        const err = JSON.stringify({ type: 'server_full', region: REGION, maxPlayers: MAX_PLAYERS });
        ws.send(err);
        setTimeout(() => ws.close(), 500);
        return null;
    }

    const room = getOrCreateRoom();
    const id = 'p' + Date.now() + Math.floor(Math.random() * 1000);

    const player = {
        id,
        name: name || 'Oyuncu',
        ws,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        health: 100,
        score: 0,
        alive: true,
        color: pickColor(room)
    };

    room.players.set(id, player);
    ws._roomId = room.id;
    ws._playerId = id;

    // Mevcut durumu gönder
    const snapshot = {
        type: 'room_join',
        roomId: room.id,
        playerId: id,
        region: REGION,
        maxPlayers: MAX_PLAYERS,
        players: Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, position: p.position, rotation: p.rotation,
            health: p.health, score: p.score, color: p.color, alive: p.alive
        })),
        wave: room.wave,
        isBossWave: room.isBossWave
    };
    send(player, snapshot);
    broadcastToRoom(room, { type: 'player_joined', id, name: player.name, color: player.color }, id);

    // Oda en az 1 oyuncuya ulaştıysa oyunu başlat
    if (!room.started && room.players.size === 1) {
        room.started = true;
        room.wave = 0;
        startNextWave(room);
    }

    return player;
}

function playerLeave(ws) {
    const room = rooms.get(ws._roomId);
    if (!room) return;
    const id = ws._playerId;
    const p = room.players.get(id);
    if (p) room.usedColors.delete(p.color);
    room.players.delete(id);
    broadcastToRoom(room, { type: 'player_left', id });
    if (room.players.size === 0) {
        rooms.delete(room.id);
    }
}

function send(player, msg) {
    if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(msg));
    }
}

function broadcastToRoom(room, msg, exceptId) {
    const data = JSON.stringify(msg);
    for (const p of room.players.values()) {
        if (p.ws.readyState === WebSocket.OPEN && p.id !== exceptId) {
            p.ws.send(data);
        }
    }
}

function broadcastState(room) {
    const state = {
        type: 'state',
        players: Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, position: p.position, rotation: p.rotation,
            health: p.health, score: p.score, color: p.color, alive: p.alive
        })),
        enemies: room.enemies.map(e => ({
            id: e.id, type: e.type, position: e.position, hp: e.hp, maxHp: e.maxHp, size: e.size
        })),
        bullets: room.bullets.map(b => ({ id: b.id, position: b.position, dir: b.dir })),
        enemyBullets: room.enemyBullets.map(b => ({ id: b.id, position: b.position, dir: b.dir })),
        wave: room.wave,
        isBossWave: room.isBossWave
    };
    for (const p of room.players.values()) {
        p.ws.send(JSON.stringify(state));
    }
}

// ===== DALGA SİSTEMİ =====
function startNextWave(room) {
    room.wave++;
    room.isBossWave = (room.wave % 5 === 0);
    room.spawnQueue = [];
    const baseCount = 4 + room.wave * 2 + room.players.size;
    const types = [];
    if (room.wave <= 2) types.push('scout');
    if (room.wave > 1) types.push('fighter');
    if (room.wave > 3) types.push('tank');

    for (let i = 0; i < baseCount; i++) {
        const t = types[Math.floor(Math.random() * types.length)];
        room.spawnQueue.push(t);
    }
    // Ses duyurusu
    broadcastToRoom(room, { type: 'wave_start', wave: room.wave, isBoss: room.isBossWave });
}

function spawnEnemy(room, type) {
    const cfg = ENEMY_TYPES[type] || ENEMY_TYPES.scout;
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 40;
    const center = roomCenter(room);
    const enemy = {
        id: 'e' + Date.now() + Math.floor(Math.random() * 10000),
        type,
        position: { x: center.x + Math.cos(angle) * dist, y: (Math.random() - 0.5) * 30, z: center.z + Math.sin(angle) * dist },
        hp: cfg.hp * (1 + room.wave * 0.2),
        maxHp: cfg.hp * (1 + room.wave * 0.2),
        speed: cfg.speed,
        score: cfg.score,
        size: cfg.size,
        moveState: Math.random() * 3
    };
    room.enemies.push(enemy);
    return enemy;
}

function roomCenter(room) {
    let x = 0, z = 0, n = 0;
    for (const p of room.players.values()) {
        if (p.alive) { x += p.position.x; z += p.position.z; n++; }
    }
    if (n === 0) return { x: 0, z: 0 };
    return { x: x / n, z: z / n };
}

// ===== TİK DÖNGÜSÜ =====
function tick(room) {
    // Spawn queue
    if (room.spawnQueue.length > 0) {
        room.spawnTimer--;
        if (room.spawnTimer <= 0) {
            room.spawnTimer = 15;
            const type = room.spawnQueue.shift();
            spawnEnemy(room, type);
        }
    } else if (room.enemies.length === 0 && room.started) {
        // Dalga bitti, yeni dalga
        setTimeout(() => startNextWave(room), 400);
    }

    // Düşman hareketi + ateş
    const center = roomCenter(room);
    for (const e of room.enemies) {
        const dx = center.x - e.position.x;
        const dz = center.z - e.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz) || 1;
        if (dist > 40) {
            e.position.x += (dx / dist) * e.speed * 0.03;
            e.position.z += (dz / dist) * e.speed * 0.03;
        } else if (dist < 20) {
            e.position.x -= (dx / dist) * e.speed * 0.015;
            e.position.z -= (dz / dist) * e.speed * 0.015;
        }

        // Düşman ateşi (rastgele)
        if (Math.random() < 0.02 && dist < 60) {
            // en yakın oyuncuya
            let tgt = null, tdist = 1e9;
            for (const p of room.players.values()) {
                if (!p.alive) continue;
                const d = Math.hypot(p.position.x - e.position.x, p.position.y - e.position.y, p.position.z - e.position.z);
                if (d < tdist) { tdist = d; tgt = p; }
            }
            if (tgt) {
                const dir = norm({ 
                    x: tgt.position.x - e.position.x + (Math.random() - 0.5) * 3,
                    y: tgt.position.y - e.position.y + (Math.random() - 0.5) * 3,
                    z: tgt.position.z - e.position.z + (Math.random() - 0.5) * 3
                });
                room.enemyBullets.push({ id: 'eb' + Date.now() + Math.random(), position: { ...e.position }, dir, life: 4 });
            }
        }
    }

    // Mermiler
    for (let i = room.enemyBullets.length - 1; i >= 0; i--) {
        const b = room.enemyBullets[i];
        b.position.x += b.dir.x * 0.9;
        b.position.y += b.dir.y * 0.9;
        b.position.z += b.dir.z * 0.9;
        b.life -= 0.03;
        if (b.life <= 0) { room.enemyBullets.splice(i, 1); continue; }

        // oyuncuya isabet?
        for (const p of room.players.values()) {
            if (!p.alive) continue;
            if (Math.hypot(p.position.x - b.position.x, p.position.y - b.position.y, p.position.z - b.position.z) < 2.2) {
                p.health -= 10;
                if (p.health <= 0) { p.health = 0; p.alive = false; }
                room.enemyBullets.splice(i, 1);
                broadcastToRoom(room, { type: 'player_hit', id: p.id, health: p.health, alive: p.alive });
                break;
            }
        }
    }

    // Oyuncu mermileri
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const b = room.bullets[i];
        b.position.x += b.dir.x * b.speed * 0.03;
        b.position.y += b.dir.y * b.speed * 0.03;
        b.position.z += b.dir.z * b.speed * 0.03;
        b.life -= 0.03;
        if (b.life <= 0) { room.bullets.splice(i, 1); continue; }

        let hitSomething = false;
        for (let j = room.enemies.length - 1; j >= 0; j--) {
            const e = room.enemies[j];
            if (Math.hypot(e.position.x - b.position.x, e.position.y - b.position.y, e.position.z - b.position.z) < (e.size + 1)) {
                e.hp -= b.damage;
                hitSomething = true;
                if (e.hp <= 0) {
                    // ödül
                    const p = room.players.get(b.ownerId);
                    if (p) p.score += e.score;
                    room.enemies.splice(j, 1);
                    broadcastToRoom(room, { type: 'enemy_destroyed', id: e.id, ownerId: b.ownerId, score: e.score });
                }
                break;
            }
        }

        // PvP: mermi başka bir oyuncuya çarpabilir (sahibine değil)
        if (!hitSomething && b.ownerId !== 'enemy') {
            for (const p of room.players.values()) {
                if (p.id === b.ownerId || !p.alive) continue;
                if (Math.hypot(p.position.x - b.position.x, p.position.y - b.position.y, p.position.z - b.position.z) < 2.4) {
                    p.health -= b.damage;
                    hitSomething = true;
                    if (p.health <= 0) {
                        p.health = 0;
                        p.alive = false;
                        const killer = room.players.get(b.ownerId);
                        if (killer) killer.score += 200; // PvP cinayet bonusu
                    }
                    broadcastToRoom(room, { type: 'player_hit', id: p.id, health: p.health, alive: p.alive, by: b.ownerId });
                    break;
                }
            }
        }

        if (hitSomething) room.bullets.splice(i, 1);
    }
}

function norm(v) {
    const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}

// ===== MESAJLAR =====
function handleMessage(ws, raw) {
    const room = rooms.get(ws._roomId);
    const player = room ? room.players.get(ws._playerId) : null;
    if (!room || !player) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
        case 'move':
            if (player.alive) {
                player.position = msg.position || player.position;
                player.rotation = msg.rotation || player.rotation;
            }
            break;
        case 'shoot':
            if (player.alive) {
                room.bullets.push({
                    id: 'b' + Date.now() + Math.random(),
                    ownerId: player.id,
                    position: { ...player.position },
                    dir: msg.dir || { x: 0, y: 0, z: -1 },
                    speed: msg.type2 === 'rocket' ? 1.6 : 2.4,
                    damage: msg.damage || 10,
                    life: 3
                });
            }
            break;
        case 'chat':
            broadcastToRoom(room, { type: 'chat', id: player.id, name: player.name, text: String(msg.text).slice(0, 100) });
            break;
    }
}

// ===== WS BAĞLANTISI =====
wss.on('connection', (ws, req) => {
    const q = url.parse(req.url, true);
    const name = q.query.name || 'Oyuncu';

    const player = playerJoin(ws, name);
    if (!player) return; // sunucu dolu

    console.log(`[+] ${player.name} odaya ${roomIdOf(ws)} katıldı`);

    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => {
        console.log(`[-] ${player.name} ayrıldı`);
        playerLeave(ws);
    });
});

function roomIdOf(ws) {
    return ws._roomId || '?';
}

// ===== ANA DÖNGÜ =====
setInterval(() => {
    for (const room of rooms.values()) {
        tick(room);
        broadcastState(room);
    }
}, TICK_MS);

server.listen(PORT, () => {
    console.log(`Space Shooter online sunucu ${PORT} portunda çalışıyor`);
});

// Uygulama kapanınca temiz
process.on('SIGINT', () => { process.exit(0); });
