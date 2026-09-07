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
            space: totalSpacePlayers(),
            agar: aPlayers.size,
            maxPlayers: MAX_PLAYERS,
            status: total >= MAX_PLAYERS ? 'full' : 'online',
            ping: 0
        }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Uzay + Agar oyun sunucu (${REGION}) Çalışıyor\n`);
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
    return total + aPlayers.size;
}

function totalSpacePlayers() {
    let total = 0;
    for (const r of rooms.values()) total += r.players.size;
    return total;
}

const ENEMY_TYPES = {
    scout: { hp: 20, speed: 6, score: 100, size: 1, color: 0xff4444, pattern: 'straight' },
    fighter: { hp: 50, speed: 9, score: 250, size: 1.5, color: 0xff8800, pattern: 'straight' },
    tank: { hp: 120, speed: 4, score: 500, size: 2.2, color: 0xaa2200, pattern: 'straight' },
    zigzag: { hp: 30, speed: 10, score: 150, size: 1.2, color: 0xff55ff, pattern: 'zigzag' },
    boss: { hp: 500, speed: 6, score: 2000, size: 3.4, color: 0xff0044, pattern: 'boss' }
};

function createRoom(id) {
    rooms.set(id, {
        id,
        players: new Map(),
        enemies: [],
        bullets: [],
        enemyBullets: [],
        powerups: [],
        wave: 0,
        isBossWave: false,
        spawnQueue: [],
        spawnTimer: 1,
        started: false,
        wavePending: false,
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
        maxHealth: 100,
        score: 0,
        alive: true,
        color: pickColor(room),
        shield: 100,
        shieldActive: 0,
        shieldCooldown: 0,
        invuln: 0,
        tripleTimer: 0,
        combo: 0,
        comboTime: 0,
        lastShotAt: 0
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
            health: p.health, maxHealth: p.maxHealth, score: p.score, color: p.color, alive: p.alive,
            shield: p.shield, shieldActive: p.shieldActive, invuln: p.invuln, tripleTimer: p.tripleTimer,
            combo: p.combo, comboTime: p.comboTime
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
            health: p.health, maxHealth: p.maxHealth, score: p.score, color: p.color, alive: p.alive,
            shield: p.shield, shieldActive: p.shieldActive, invuln: p.invuln, tripleTimer: p.tripleTimer,
            combo: p.combo, comboTime: p.comboTime
        })),
        enemies: room.enemies.map(e => ({
            id: e.id, type: e.type, pattern: e.pattern, position: e.position, hp: e.hp, maxHp: e.maxHp, size: e.size
        })),
        bullets: room.bullets.map(b => ({ id: b.id, position: b.position, dir: b.dir, t2: b.t2 || 0 })),
        enemyBullets: room.enemyBullets.map(b => ({ id: b.id, position: b.position, dir: b.dir })),
        powerups: room.powerups.filter(p => p).map(pu => ({ id: pu.id, type: pu.type, position: pu.position })),
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
    // Zorluk formülü: floor(5 + wave * 1.5) + oyuncu sayısı
    const baseCount = Math.floor(5 + room.wave * 1.5) + room.players.size;
    const types = [];
    if (room.wave <= 2) types.push('scout');
    if (room.wave > 1) types.push('fighter');
    if (room.wave > 3) types.push('tank');
    if (room.wave > 5) types.push('zigzag');

    if (room.isBossWave) {
        room.spawnQueue.push('boss');
        room.spawnQueue.push('scout', 'fighter', 'scout');
    }
    for (let i = 0; i < baseCount; i++) {
        const t = types[Math.floor(Math.random() * types.length)];
        room.spawnQueue.push(t);
    }

    // Her 3 dalgada oyuncunun max canı +%15
    if (room.wave % 3 === 0) {
        for (const p of room.players.values()) {
            p.maxHealth = Math.round(p.maxHealth * 1.15);
            p.health = Math.min(p.maxHealth, p.health + 10);
        }
    }
    // Ses duyurusu
    broadcastToRoom(room, { type: 'wave_start', wave: room.wave, isBoss: room.isBossWave });
}

function spawnEnemy(room, type) {
    const cfg = ENEMY_TYPES[type] || ENEMY_TYPES.scout;
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 40;
    const center = roomCenter(room);
    let pattern = cfg.pattern || 'straight';
    if (type === 'fighter' && room.wave > 4 && Math.random() < 0.4) pattern = 'orbit';
    if (type === 'tank' && room.wave > 5 && Math.random() < 0.35) pattern = 'orbit';
    const enemy = {
        id: 'e' + Date.now() + Math.floor(Math.random() * 10000),
        type,
        pattern,
        position: { x: center.x + Math.cos(angle) * dist, y: (Math.random() - 0.5) * 30, z: center.z + Math.sin(angle) * dist },
        hp: cfg.hp * (1 + room.wave * 0.2),
        maxHp: cfg.hp * (1 + room.wave * 0.2),
        speed: cfg.speed,
        score: cfg.score,
        size: cfg.size,
        age: 0,
        fireT: 30 + Math.floor(Math.random() * 30)
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
    // Kalkan enerjisi yenilenir + aktif süre/cooldown azalır
    for (const p of room.players.values()) {
        if (p.shieldActive > 0) {
            p.shieldActive = Math.max(0, p.shieldActive - 0.03);
        }
        if (p.shieldCooldown > 0) {
            p.shieldCooldown = Math.max(0, p.shieldCooldown - 0.03);
        }
        if (p.alive) {
            p.shield = Math.min(100, p.shield + 0.33); // ~10/sn dolum
        }
    }

    // Ölen oyuncular için yeniden doğuş sayacı (~8 sn)
    for (const p of room.players.values()) {
        if (!p.alive) {
            p.respawnTimer = (p.respawnTimer == null ? 8 : p.respawnTimer);
            p.respawnTimer -= 0.03;
            if (p.respawnTimer <= 0) {
                const center = roomCenter(room);
                p.alive = true;
                p.health = p.maxHealth;   // max cana dönsün (dalga artışı korunur)
                p.shield = 100;
                p.shieldActive = 0;
                p.shieldCooldown = 0;
                p.invuln = 30;            // doğar doğmaz ölmesin (~1 sn koruma)
                p.combo = 0; p.comboTime = 0;
                p.position = { x: center.x + (Math.random() - 0.5) * 8, y: 0, z: center.z + (Math.random() - 0.5) * 8 };
                p.rotation = { x: 0, y: 0, z: 0 };
                p.respawnTimer = null;
                broadcastToRoom(room, { type: 'player_respawn', id: p.id, position: p.position });
            }
        }
    }
    // Ateşli silah süresi + dogunma koruması + kombo süresi tick'i
    for (const p of room.players.values()) {
        if (p.tripleTimer > 0) p.tripleTimer = Math.max(0, p.tripleTimer - 0.03);
        if (p.invuln > 0) p.invuln--;
        if (p.comboTime > 0) {
            p.comboTime -= 0.03;
            if (p.comboTime <= 0) p.combo = 0;
        }
    }
    // Spawn queue (ekranda en fazla 8 düşman)
    if (room.spawnQueue.length > 0 && room.enemies.length < 8) {
        room.spawnTimer--;
        if (room.spawnTimer <= 0) {
            room.spawnTimer = 12;
            const type = room.spawnQueue.shift();
            spawnEnemy(room, type);
        }
    } else if (!room.wavePending && room.spawnQueue.length === 0 && room.enemies.length === 0 && room.started) {
        // Dalga bitti — tek sefer tetikle (her tick'te birkaç kez başlamasın)
        room.wavePending = true;
        const bonus = 100 * Math.max(1, room.players.size);
        for (const p of room.players.values()) if (p.alive) p.score += bonus;
        broadcastToRoom(room, { type: 'wave_finish', wave: room.wave, bonus });
        setTimeout(() => { room.wavePending = false; startNextWave(room); }, 900);
    }

    // Power-up toplama
    for (let i = room.powerups.length - 1; i >= 0; i--) {
        const pu = room.powerups[i];
        pu.life = (pu.life || 15) - 0.03;
        if (pu.life <= 0) { room.powerups.splice(i, 1); continue; }
        let got = null;
        for (const p of room.players.values()) {
            if (!p.alive) continue;
            if (Math.hypot(p.position.x - pu.position.x, p.position.y - pu.position.y, p.position.z - pu.position.z) < 3) { got = p; break; }
        }
        if (got) {
            let cur = null;
            if (pu.type === 'triple') { got.tripleTimer = 10; cur = 'triple'; }
            else if (pu.type === 'shield') { got.shield = Math.min(100, got.shield + 40); cur = 'shield'; }
            else if (pu.type === 'health') { got.health = Math.min(got.maxHealth, got.health + 20); cur = 'health'; }
            room.powerups.splice(i, 1);
            broadcastToRoom(room, { type: 'powerup_collected', id: pu.id, type: cur, by: got.id });
        }
    }

    // Düşman hareketi + ateş (pattern odaklı)
    const center = roomCenter(room);
    for (const e of room.enemies) {
        const dx = center.x - e.position.x;
        const dz = center.z - e.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz) || 1;
        const dirx = dx / dist, dirz = dz / dist;
        e.age = (e.age || 0) + 0.03;
        const sp = e.speed;

        if (e.pattern === 'zigzag') {
            const osc = Math.sin(e.age * 4) * 0.8;
            const px = -dirz, pz = dirx;
            e.position.x += (dirx * sp + px * sp * osc) * 0.03;
            e.position.z += (dirz * sp + pz * sp * osc) * 0.03;
        } else if (e.pattern === 'orbit') {
            const r = Math.max(14, 38 - e.age * 3);
            e.orbitPhase = (e.orbitPhase == null ? e.age * 2 : e.orbitPhase) + 0.03 * (1 + sp * 0.03);
            e.position.x = center.x + Math.cos(e.orbitPhase) * r;
            e.position.z = center.z + Math.sin(e.orbitPhase) * r;
        } else if (e.pattern === 'boss') {
            // Boss: yörüngede döner, hp düştükçe hızlanır, faz 3'te yavru çağırır
            const hpRatio = Math.max(0.01, e.hp / e.maxHp);
            e.orbitPhase = (e.orbitPhase || 0) + 0.03 * (0.7 + (1 - hpRatio) * 0.8);
            e.position.x = center.x + Math.cos(e.orbitPhase) * 42;
            e.position.z = center.z + Math.sin(e.orbitPhase) * 42;
            e.position.y = Math.sin(e.age * 0.5) * 8;
            if (hpRatio < 0.35 && room.enemies.length < 10 && room.spawnQueue.length === 0 && Math.random() < 0.02) {
                spawnEnemy(room, 'scout');
            }
        } else {
            if (dist > 45) { e.position.x += dirx * sp * 0.03; e.position.z += dirz * sp * 0.03; }
            else if (dist < 18) { e.position.x -= dirx * sp * 0.016; e.position.z -= dirz * sp * 0.016; }
        }

        // Düşman ateşi — boss fazlara göre salvosu yüksek tutulur
        e.fireT = (e.fireT || 0) - 1;
        if (e.fireT <= 0) {
            let tgt = null, tdist = 1e9;
            for (const p of room.players.values()) {
                if (!p.alive) continue;
                const d = Math.hypot(p.position.x - e.position.x, p.position.y - e.position.y, p.position.z - e.position.z);
                if (d < tdist) { tdist = d; tgt = p; }
            }
            if (tgt && tdist < (e.pattern === 'boss' ? 110 : 60)) {
                const hpRatio = Math.max(0.01, e.hp / e.maxHp);
                const burst = e.pattern === 'boss'
                    ? (hpRatio > 0.6 ? 3 : hpRatio > 0.3 ? 5 : 7)
                    : 1;
                for (let k = 0; k < burst; k++) {
                    const off = e.pattern === 'boss' ? (k - (burst - 1) / 2) * 0.3 : (Math.random() - 0.5) * 3;
                    const dir = norm({
                        x: tgt.position.x - e.position.x + off,
                        y: tgt.position.y - e.position.y + (Math.random() - 0.5) * 3,
                        z: tgt.position.z - e.position.z + (Math.random() - 0.5) * 3
                    });
                    room.enemyBullets.push({ id: 'eb' + Date.now() + Math.random() + k, position: { ...e.position }, dir, life: 4 });
                }
                const rapid = e.pattern === 'boss' ? (1 - hpRatio) * 12 : 0;
                e.fireT = (e.pattern === 'boss' ? 26 : 50) + Math.floor(Math.random() * 30) - rapid;
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
            const dist = Math.hypot(p.position.x - b.position.x, p.position.y - b.position.y, p.position.z - b.position.z);
            // Kalkan küresi (yarıçap 3.0) mermiyi bloklar — görselle uyumlu
            if (dist < 3.0 && p.shieldActive > 0) {
                room.enemyBullets.splice(i, 1);
                broadcastToRoom(room, { type: 'player_shield_hit', id: p.id });
                break;
            }
            if (dist < 2.2) {
                if (p.invuln > 0) break; // dokunulmazlık süresi — mermi geçer
                p.health -= 10;
                p.invuln = 15; // ~0.5 sn dokunulmazlık
                p.combo = 0; p.comboTime = 0; // hasar alınca kombo sıfırlanır
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
                    // ödül — kombo çarpanı: 3 kill'de bir kademe (x1 → x5)
                    const p = room.players.get(b.ownerId);
                    if (p) {
                        p.combo = (p.combo || 0) + 1;
                        p.comboTime = 5;
                        const mult = 1 + Math.min(4, Math.floor(p.combo / 3));
                        p.score += e.score * mult;
                    }
                    room.enemies.splice(j, 1);
                    // %15 ihtimalle güç-yükseltme; boss her zaman bırakır
                    if (e.pattern === 'boss') {
                        room.powerups.push({ id: 'pu' + Date.now() + Math.random(), type: 'triple', position: { ...e.position }, life: 20 });
                    } else if (Math.random() < 0.15) {
                        room.powerups.push({
                            id: 'pu' + Date.now() + Math.random(),
                            type: ['triple', 'shield', 'health'][Math.floor(Math.random() * 3)],
                            position: { ...e.position }, life: 15
                        });
                    }
                    broadcastToRoom(room, { type: 'enemy_destroyed', id: e.id, ownerId: b.ownerId, score: e.score });
                }
                break;
            }
        }

        // PvP: mermi başka bir oyuncuya çarpabilir (sahibine değil)
        if (!hitSomething && b.ownerId !== 'enemy') {
            for (const p of room.players.values()) {
                if (p.id === b.ownerId || !p.alive) continue;
                const pvpDist = Math.hypot(p.position.x - b.position.x, p.position.y - b.position.y, p.position.z - b.position.z);
                if (pvpDist < 3.0 && p.shieldActive > 0) {
                    hitSomething = true;
                    broadcastToRoom(room, { type: 'player_shield_hit', id: p.id });
                    break;
                }
                if (pvpDist < 2.2) {
                    if (p.invuln > 0) break; // dokunulmazlık
                    p.health -= b.damage;
                    p.invuln = 15;
                    p.combo = 0; p.comboTime = 0;
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
        case 'ping':
            // Gerçek RTT ölçümü: client'in gönderdiği zaman damgasını aynen geri gönder
            send(player, { type: 'pong', t: msg.t });
            break;
        case 'shoot':
            if (player.alive) {
                if (Date.now() - (player.lastShotAt || 0) < 50) break; // hızlı tıklama koruması
                player.lastShotAt = Date.now();
                if (player.tripleTimer > 0) {
                    // Güç-yükseltme: paralel 3 lü atış
                    const base = msg.dir || { x: 0, y: 0, z: -1 };
                    for (let k = -1; k <= 1; k++) {
                        room.bullets.push({
                            id: 'b' + Date.now() + Math.random() + k,
                            ownerId: player.id,
                            position: { ...player.position },
                            dir: norm({ x: base.x - base.z * 0.4 * k, y: base.y, z: base.z + base.x * 0.4 * k }),
                            speed: 66, damage: 8, life: 3, t2: 2
                        });
                    }
                } else if (msg.type2 === 2) {
                    // Spread silahı: sağa/sola iki çapraz ek mermi
                    const base = msg.dir || { x: 0, y: 0, z: -1 };
                    for (let k = -1; k <= 1; k++) {
                        const d = norm({ x: base.x + k * 0.35, y: base.y, z: base.z });
                        room.bullets.push({
                            id: 'b' + Date.now() + Math.random() + k,
                            ownerId: player.id,
                            position: { ...player.position },
                            dir: d, speed: 66, damage: 7, life: 3, t2: 2
                        });
                    }
                } else {
                    // Hasar sunucuda belirlenir (client'a güvenilmez): roket ağır vurur
                    const t2 = msg.type2 === 1 ? 1 : 0;
                    room.bullets.push({
                        id: 'b' + Date.now() + Math.random(),
                        ownerId: player.id,
                        position: { ...player.position },
                        dir: msg.dir || { x: 0, y: 0, z: -1 },
                        speed: t2 === 1 ? 45 : 66,
                        damage: t2 === 1 ? 30 : 10,
                        life: t2 === 1 ? 6 : 4,
                        t2
                    });
                }
            }
            break;
        case 'use_shield':
            if (player.alive && player.shield >= 10 && player.shieldActive <= 0 && player.shieldCooldown <= 0) {
                player.shield -= 10;
                player.shieldActive = 7;      // 7 saniye aktif koruma
                player.shieldCooldown = 20;   // 20 saniye bekleme
                broadcastToRoom(room, { type: 'shield_used', id: player.id, shield: player.shield, shieldActive: player.shieldActive, shieldCooldown: player.shieldCooldown });
            }
            break;
        case 'chat':
            broadcastToRoom(room, { type: 'chat', id: player.id, name: player.name, text: String(msg.text).slice(0, 100) });
            break;
    }
}

// ===== AGAR MODU (2D blob — agar.io grafik + mekanik: bölün, yem at, virüs) =====
const A_W = 2000, A_H = 2000;
const A_FOOD_TARGET = 1000;
const AGAR_COLORS = ['#ff5555', '#4ecdc4', '#ffe66d', '#6c5ce7', '#fd79a8', '#00b894', '#fdcb6e', '#e17055', '#0984e3', '#a29bfe', '#ff9ff3', '#feca57'];
const aPlayers = new Map(); // id -> { id, name, ws, color, cells:[], tx, ty, remergeUntil }
let aFood = [];    // küçük yem noktaları
let aPellets = []; // fırlatılan kütle parçaları
let aViruses = []; // yeşil virüsler
let aFoodId = 1, aPelletId = 1, aVirusId = 1, aCellId = 1;

// Feast event: her 3 dk'da bir 30 sn boyunca yem değerleri x2
let feastMode = false;
let feastEnd = 0;
let feastGoldenId = null; // dev altın yem id
let feastNext = Date.now() + 180000; // ilk feast 3 dk sonra

function aR(mass) { return Math.sqrt(mass) * 4; }
function aPTotal(p) { return p.cells.reduce((s, c) => s + c.mass, 0); }

function ensureFood() {
    while (aFood.length < A_FOOD_TARGET) {
        const big = Math.random() < 0.08; // %8 büyük (renkli) yem
        aFood.push({
            id: 'f' + (aFoodId++),
            x: Math.random() * A_W, y: Math.random() * A_H,
            r: big ? 12 : 3 + Math.random() * 2,
            c: Math.random() < 0.65 ? '#ddf2ff' : AGAR_COLORS[Math.floor(Math.random() * AGAR_COLORS.length)],
            m: big ? 2 : 1
        });
    }
}
ensureFood();

function spawnVirusNearRandom() {
    for (let tries = 0; tries < 40; tries++) {
        const v = { id: 'vr' + (aVirusId++), x: 150 + Math.random() * (A_W - 300), y: 150 + Math.random() * (A_H - 300), r: 26 };
        let bad = false;
        for (const p of aPlayers.values()) for (const c of p.cells) {
            if (Math.hypot(v.x - c.x, v.y - c.y) < 330) { bad = true; break; }
        }
        if (!bad) return v;
    }
    return { id: 'vr' + (aVirusId++), x: Math.random() * A_W, y: Math.random() * A_H, r: 26 };
}
function ensureViruses() { while (aViruses.length < 12) aViruses.push(spawnVirusNearRandom()); }
ensureViruses();

// Feast event sistemi
function startFeast() {
    feastMode = true;
    feastEnd = Date.now() + 30000;
    feastGoldenId = 'gf' + Date.now();
    // harita ortasına dev altın yem ekle
    aFood.push({ id: feastGoldenId, x: A_W / 2, y: A_H / 2, r: 22, c: '#ffd700', m: 25 });
    broadcastA({ type: 'feast_start', duration: 30 });
}
function endFeast() {
    feastMode = false;
    feastGoldenId = null;
    feastNext = Date.now() + 180000; // 3 dk sonra tekrar
    broadcastA({ type: 'feast_end' });
}
function feastTick() {
    if (feastMode && Date.now() >= feastEnd) endFeast();
    else if (!feastMode && Date.now() >= feastNext) startFeast();
}
setInterval(feastTick, 1000);

function safeCellPos() {
    for (let tries = 0; tries < 40; tries++) {
        const x = 300 + Math.random() * (A_W - 600);
        const y = 300 + Math.random() * (A_H - 600);
        let bad = false;
        for (const p of aPlayers.values()) for (const c of p.cells) {
            if (Math.hypot(c.x - x, c.y - y) < aR(c.mass) * 2 + 70) { bad = true; break; }
        }
        if (!bad) return { x, y };
    }
    return { x: A_W / 2, y: A_H / 2 };
}
function newCell(x, y, mass, vx, vy) {
    return { i: aCellId++, x, y, mass, r: aR(mass), vx: vx || 0, vy: vy || 0 };
}

function aSnap() {
    return Array.from(aPlayers.values()).map(p => ({
        id: p.id, name: p.name, color: p.color, mass: Math.floor(aPTotal(p)),
        cells: p.cells.map(c => ({ x: c.x, y: c.y, r: c.r, mass: c.mass })),
        remergeUntil: p.remergeUntil || 0,
        invulnUntil: p.invulnUntil || 0
    }));
}

function broadcastA(msg, exceptWs) {
    const data = JSON.stringify(msg);
    for (const p of aPlayers.values()) {
        if (p.ws.readyState === WebSocket.OPEN && p.ws !== exceptWs) p.ws.send(data);
    }
}
function sendA(p, msg) { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg)); }

function agarConnect(ws, name) {
    if (aPlayers.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'server_full', region: REGION, maxPlayers: MAX_PLAYERS }));
        setTimeout(() => ws.close(), 500);
        return;
    }
    const id = 'a' + Date.now() + Math.floor(Math.random() * 1000);
    const sp = safeCellPos();
    const p = {
        id, name: name || 'Oyuncu', ws,
        color: AGAR_COLORS[Math.floor(Math.random() * AGAR_COLORS.length)],
        cells: [], tx: sp.x, ty: sp.y, remergeUntil: 0,
        lastSplitTime: 0, chainCombo: 0, invulnUntil: Date.now() + 3000
    };
    p.cells.push(newCell(sp.x, sp.y, 25));
    aPlayers.set(id, p);
    ws._playerId = id;
    ws._mode = 'agar';
    ensureFood(); ensureViruses();
    sendA(p, {
        type: 'board', W: A_W, H: A_H, me: id, region: REGION,
        players: aSnap(),
        food: aFood,
        pellets: aPellets.map(f => ({ id: f.id, x: f.x, y: f.y, r: f.r, vx: f.vx, vy: f.vy, color: f.color || '#bfe0a0' })),
        viruses: aViruses.map(v => ({ id: v.id, x: v.x, y: v.y, r: v.r }))
    });
    broadcastA({ type: 'player_joined', p: aSnap().find(s => s.id === id) }, ws);
    console.log(`[+] ${p.name} (agar) katıldı`);
}

function agarSplit(p) {
    if (p.cells.length >= 8) return;
    let spawned = 0;
    for (const c of p.cells.slice()) {
        if (c.mass < 36) continue;
        const dx = p.tx - c.x, dy = p.ty - c.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d;
        const half = c.mass / 2;
        c.mass = half; c.r = aR(half);
        p.cells.push(newCell(c.x + ux * c.r * 1.4, c.y + uy * c.r * 1.4, half, ux * 150, uy * 150));
        spawned++;
        if (p.cells.length >= 8) break;
    }
    if (spawned) {
        p.remergeUntil = Date.now() + Math.min(30000, 4000 + aPTotal(p) * 8);
        p.lastSplitTime = Date.now();
    }
}

function agarEject(p) {
    let c = null, cm = -1;
    for (const cc of p.cells) if (cc.mass > cm) { cm = cc.mass; c = cc; }
    if (!c || c.mass < 40) return;
    const dx = p.tx - c.x, dy = p.ty - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    c.mass -= 14; c.r = aR(c.mass);
    const pel = { id: 'ap' + (aPelletId++), x: c.x + ux * (c.r + 10), y: c.y + uy * (c.r + 10), r: 7, mass: 14, vx: ux * 220, vy: uy * 220, born: Date.now(), color: p.color };
    aPellets.push(pel);
    c.vx -= ux * 30; c.vy -= uy * 30;
    broadcastA({ type: 'ejected', pellet: { id: pel.id, x: pel.x, y: pel.y, r: pel.r, vx: pel.vx, vy: pel.vy, color: pel.color } });
}

function agarExplodeCell(p, c) {
    const idx = p.cells.indexOf(c);
    if (idx < 0) return;
    p.cells.splice(idx, 1);
    const nPieces = Math.max(2, Math.min(8, 16 - p.cells.length));
    if (nPieces < 2) { p.cells.push(newCell(c.x, c.y, Math.max(25, c.mass))); return; }
    const pm = Math.max(20, c.mass / nPieces);
    for (let k = 0; k < nPieces; k++) {
        const a = Math.random() * Math.PI * 2;
        p.cells.push(newCell(Math.max(c.r, Math.min(A_W - c.r, c.x + Math.cos(a) * 10)), Math.max(c.r, Math.min(A_H - c.r, c.y + Math.sin(a) * 10)), pm, Math.cos(a) * 190, Math.sin(a) * 190));
    }
    p.remergeUntil = Date.now() + Math.min(30000, 4000 + aPTotal(p) * 8);
    broadcastA({ type: 'spray', x: c.x, y: c.y, color: p.color, n: 22 });
}

function agarHandleMessage(p, msg) {
    switch (msg.type) {
        case 'aim':
            if (typeof msg.x === 'number' && typeof msg.y === 'number') {
                p.tx = Math.max(0, Math.min(A_W, msg.x));
                p.ty = Math.max(0, Math.min(A_H, msg.y));
            }
            break;
        case 'split':
            agarSplit(p);
            break;
        case 'eject':
            agarEject(p);
            break;
        case 'chat':
            broadcastA({ type: 'chat', id: p.id, name: p.name, text: String(msg.text).slice(0, 100) });
            break;
        case 'ping':
            sendA(p, { type: 'pong', t: msg.t });
            break;
    }
}

function agarTick() {
    if (aPlayers.size === 0) return;
    if (aFood.length < A_FOOD_TARGET - 100) ensureFood();
    const dt = 0.1;

    // Hareket: her hücre hedefe gider, fırlatma impulsu söner
    for (const p of aPlayers.values()) {
        for (const c of p.cells) {
            c.vx *= 0.88; c.vy *= 0.88;
            // aynı oyuncunun hücrelerini ayır (üst üste binmesin)
            for (const o of p.cells) {
                if (o === c) continue;
                const sx = c.x - o.x, sy = c.y - o.y;
                const sd = Math.hypot(sx, sy);
                const minD = (c.r + o.r) * 0.72;
                if (sd < minD) {
                    const push = (minD - sd) * 0.2;
                    c.x += (sx / (sd || 1)) * push;
                    c.y += (sy / (sd || 1)) * push;
                }
            }
            const dx = p.tx - c.x, dy = p.ty - c.y;
            const d = Math.hypot(dx, dy);
            if (d > 18) {
                const sp = Math.max(50, 335 * Math.sqrt(25 / c.mass));
                const m = Math.min(sp * dt, d);
                c.x += (dx / d) * m + c.vx * dt;
                c.y += (dy / d) * m + c.vy * dt;
            } else {
                c.x += c.vx * dt; c.y += c.vy * dt;
            }
            c.x = Math.max(c.r, Math.min(A_W - c.r, c.x));
            c.y = Math.max(c.r, Math.min(A_H - c.r, c.y));
            c.mass = Math.max(25, c.mass - c.mass * 0.0007);
            c.r = aR(c.mass);
        }
    }

    // Fırlatılan kütle parçaları
    for (const f of aPellets) {
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.vx *= 0.9; f.vy *= 0.9;
        // Magnetic pellets: feast son 5sn'de en yakın oyuncuya çek
        if (feastMode && Date.now() > feastEnd - 5000 && aPlayers.size > 0) {
            let nearP = null, nearD = 99999;
            for (const p of aPlayers.values()) {
                for (const c of p.cells) {
                    const dd = Math.hypot(c.x - f.x, c.y - f.y);
                    if (dd < nearD) { nearD = dd; nearP = c; }
                }
            }
            if (nearP && nearD > 1) {
                const pull = 80 * dt;
                f.vx += ((nearP.x - f.x) / nearD) * pull;
                f.vy += ((nearP.y - f.y) / nearD) * pull;
            }
        }
        f.x = Math.max(f.r, Math.min(A_W - f.r, f.x));
        f.y = Math.max(f.r, Math.min(A_H - f.r, f.y));
    }
    aPellets = aPellets.filter(f => Date.now() - f.born < 45000);

    // Yem + parça toplama + virüs
    const eatenFood = [];
    for (const p of aPlayers.values()) {
        for (let ci = 0; ci < p.cells.length; ci++) {
            const c = p.cells[ci];
            for (let i = aFood.length - 1; i >= 0; i--) {
                const f = aFood[i];
                if (Math.hypot(c.x - f.x, c.y - f.y) < c.r + f.r * 0.5) {
                    const val = feastMode ? f.m * 2 : f.m;
                    c.mass += val; c.r = aR(c.mass);
                    aFood.splice(i, 1); eatenFood.push(f.id);
                    if (f.id === feastGoldenId) { feastGoldenId = null; broadcastA({ type: 'golden_eaten', eater: p.name }); }
                }
            }
            for (let i = aPellets.length - 1; i >= 0; i--) {
                const f = aPellets[i];
                if (c.mass > f.mass && Math.hypot(c.x - f.x, c.y - f.y) < c.r + f.r * 0.4) {
                    c.mass += f.mass; c.r = aR(c.mass);
                    aPellets.splice(i, 1);
                    broadcastA({ type: 'pellet_eaten', id: f.id });
                }
            }
            // Virüs: büyük hücre patlar
            if (c.mass >= 100) {
                for (let k = aViruses.length - 1; k >= 0; k--) {
                    const v = aViruses[k];
                    if (Math.hypot(c.x - v.x, c.y - v.y) < c.r * 0.7 + v.r * 0.5) {
                        aViruses.splice(k, 1);
                        broadcastA({ type: 'virus_eaten', vid: v.id, x: v.x, y: v.y });
                        const nv = spawnVirusNearRandom();
                        aViruses.push(nv);
                        broadcastA({ type: 'virus_add', v: { id: nv.id, x: nv.x, y: nv.y, r: nv.r } });
                        agarExplodeCell(p, c);
                        ci--;
                        break;
                    }
                }
            }
        }
    }
    if (eatenFood.length) broadcastA({ type: 'food_eaten', ids: eatenFood });

    // Oyuncu hücresi yeme (büyük, küçük hücreyi yutar)
    const plist = Array.from(aPlayers.values());
    for (const big of plist) {
        for (const bcell of big.cells) {
            for (const sm of plist) {
                if (big === sm) continue;
                for (let si = sm.cells.length - 1; si >= 0; si--) {
                    const sc = sm.cells[si];
                    if (sm.invulnUntil > Date.now()) continue; // dokunulmaz
                    if (bcell.mass / sc.mass < 1.2) continue;
                    const d = Math.hypot(bcell.x - sc.x, bcell.y - sc.y);
                    if (d < bcell.r - sc.r * 0.4) {
                        bcell.mass += sc.mass; bcell.r = aR(bcell.mass);
                        sm.cells.splice(si, 1);
                        broadcastA({ type: 'spray', x: sc.x, y: sc.y, color: sm.color, n: 16 });
                    }
                }
                if (sm.cells.length === 0 && aPlayers.has(sm.id)) {
                    const sp2 = safeCellPos();
                    sm.cells.push(newCell(sp2.x, sp2.y, 25));
                    sm.tx = sp2.x; sm.ty = sp2.y;
                    sm.invulnUntil = Date.now() + 3000; // 3 sn dokunulmazlik
                    broadcastA({ type: 'eaten', eater: big.id, victim: sm.id, mass: Math.floor(aPTotal(big)) });
                    broadcastA({ type: 'killfeed', killer: big.name, victim: sm.name });
                    // Chain combo: split'ten 3sn sonra yutma
                    if (big.lastSplitTime && Date.now() - big.lastSplitTime < 3000) {
                        big.chainCombo++;
                        const bonus = Math.floor(sc.mass * 0.1);
                        big.mass += bonus; big.r = aR(big.mass);
                        broadcastA({ type: 'chain_combo', player: big.name, combo: big.chainCombo, bonus: bonus });
                    } else {
                        big.chainCombo = 0;
                    }
                }
            }
        }
    }

    // Kendi hücrelerini birleştir (süre bitince)
    for (const p of aPlayers.values()) {
        if (p.cells.length <= 1 || p.remergeUntil > Date.now()) continue;
        let changed = true;
        while (changed) {
            changed = false;
            const cl = p.cells.slice();
            for (let i = 0; i < cl.length && !changed; i++) {
                for (let j = i + 1; j < cl.length && !changed; j++) {
                    const a = cl[i], b = cl[j];
                    const mx = Math.max(a.mass, b.mass), mn = Math.min(a.mass, b.mass);
                    if (mx / mn < 1) continue;
                    const big = a.mass >= b.mass ? a : b;
                    const small = a.mass >= b.mass ? b : a;
                    if (Math.hypot(big.x - small.x, big.y - small.y) < big.r - small.r * 0.6) {
                        big.mass += small.mass; big.r = aR(big.mass);
                        p.cells = p.cells.filter(cr => cr !== small);
                        changed = true;
                        break;
                    }
                }
            }
        }
    }

    // Lider + durum (5x/sn throttle)
let lastStateBroadcast = 0;
    const now = Date.now();
    if (now - lastStateBroadcast < 200) return;
    lastStateBroadcast = now;
    const lb = Array.from(aPlayers.values())
        .map(p => ({ id: p.id, name: p.name, mass: Math.floor(aPTotal(p)) }))
        .sort((a, b) => b.mass - a.mass)
        .slice(0, 10);
    broadcastA({ type: 'state', players: aSnap(), leaderboard: lb, totalPlayers: aPlayers.size });
}

setInterval(agarTick, 100);

// ===== WS BAĞLANTISI =====
wss.on('connection', (ws, req) => {
    const q = url.parse(req.url, true);
    const name = q.query.name || 'Oyuncu';

    // AGAR modu (2D blob): aynı sunucu, farklı oyun
    if (q.query.mode === 'agar') {
        agarConnect(ws, name);
        ws.on('message', (data) => {
            const p = aPlayers.get(ws._playerId);
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (e) { return; }
            if (p && msg && msg.type) agarHandleMessage(p, msg);
        });
        ws.on('close', () => {
            const p = aPlayers.get(ws._playerId);
            if (p) {
                console.log(`[-] ${p.name} (agar) ayrıldı`);
                aPlayers.delete(ws._playerId);
                broadcastA({ type: 'player_left', id: ws._playerId });
            }
        });
        return;
    }

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
    console.log(`Uzay + Agar oyun sunucu ${PORT} portunda çalışıyor`);
});

// Uygulama kapanınca temiz
process.on('SIGINT', () => { process.exit(0); });
