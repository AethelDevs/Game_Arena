'use strict';
/*
 * Room: una partida completa (servidor autoritativo).
 * Simula jugadores, balas, recogidas, rondas y bots a 30 ticks/s y emite snapshots.
 */
const S = require('../shared/shared');

const CFG = Object.freeze({
  tickRate: 30,
  maxHp: 100,
  bulletDamage: 20,
  bulletLife: 0.9,       // s  (alcance ~855 px)
  fireCooldown: 0.2,     // s
  rapidCooldown: 0.09,   // s
  rapidTime: 8,          // s
  respawnTime: 3,        // s
  protectTime: 2,        // s de invulnerabilidad al reaparecer
  healthAmount: 40,
  pickupRespawn: 20,     // s
  pickupRadius: 30,
  killLimit: 20,         // bajas para ganar la ronda
  intermission: 8,       // s entre rondas
  maxPlayers: 16,
});

const DT = 1 / CFG.tickRate;
const BOT_NAMES = ['Bot Alfa', 'Bot Bravo', 'Bot Charlie', 'Bot Delta', 'Bot Eco', 'Bot Foxtrot'];
const COLORS = ['#ff5d5d', '#ffb347', '#ffe66d', '#7bed9f', '#4dd0e1', '#5c9dff', '#b388ff', '#ff7eb6'];
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

class Room {
  constructor(id, io, opts = {}) {
    this.id = id;
    this.io = io;
    this.channel = 'room:' + id; // prefijo para no chocar con salas internas de socket.io
    this.botFill = opts.botFill || 0;
    this.players = new Map();
    this.bullets = [];
    this.nextPlayerId = 1;
    this.nextBulletId = 1;
    this.pickupActive = S.PICKUPS.map(() => true);
    this.pickupAt = S.PICKUPS.map(() => 0);
    this.fx = [];
    this.intermissionUntil = 0;
    this.boardDirty = true;
    this.lastBoardAt = 0;
    this.timer = null;
    this.totalShots = 0;
  }

  now() { return Date.now(); }

  // ---------- ciclo de vida ----------
  start() {
    let next = Date.now();
    const loop = () => {
      const t = Date.now();
      let steps = 0;
      while (next <= t && steps < 5) {
        this.step();
        next += 1000 / CFG.tickRate;
        steps++;
      }
      if (next < t - 250) next = t;
      this.timer = setTimeout(loop, Math.max(1, next - Date.now()));
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  publicConfig() {
    return {
      tickRate: CFG.tickRate,
      maxHp: CFG.maxHp,
      killLimit: CFG.killLimit,
      rapidMs: CFG.rapidTime * 1000,
    };
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  botCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot) n++;
    return n;
  }

  info() {
    return { id: this.id, players: this.humanCount(), bots: this.botCount(), max: CFG.maxPlayers };
  }

  emitRoom(ev, data) { this.io.to(this.channel).emit(ev, data); }

  sys(text) { this.emitRoom('chat', { s: 1, t: text }); }

  // ---------- jugadores ----------
  makePlayer({ name, color, socket = null, isBot = false }) {
    const now = this.now();
    return {
      id: this.nextPlayerId++, name, color, socket, isBot,
      x: 0, y: 0, angle: 0, hp: CFG.maxHp, alive: false,
      kills: 0, deaths: 0,
      keys: 0, shoot: false, queue: [], seq: 0, lastQueuedSeq: 0,
      budget: 0.1, lastInputAt: now, inputTokens: 60, inputTokensAt: now,
      cooldown: 0, rapidUntil: 0, protectedUntil: 0, respawnAt: 0, lastChatAt: 0,
      ai: isBot ? {
        target: null, goal: null, aimErr: 0, strafeDir: 1, wander: { x: 1, y: 0 },
        retargetAt: 0, strafeAt: 0, checkAt: 0, lx: 0, ly: 0,
        wantMove: false, unstuckUntil: 0, unstuck: { x: 0, y: 0 },
      } : null,
    };
  }

  addHuman(socket, rawName, rawColor) {
    const name = String(rawName == null ? '' : rawName)
      .replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
      || 'Jugador' + Math.floor(100 + Math.random() * 900);
    const color = typeof rawColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(rawColor)
      ? rawColor : COLORS[Math.floor(Math.random() * COLORS.length)];
    const p = this.makePlayer({ name, color, socket });
    this.players.set(p.id, p);
    socket.join(this.channel);
    this.spawn(p, this.now());
    this.sys(`${p.name} entró a la sala`);
    this.syncBots();
    this.boardDirty = true;
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (!p.isBot) this.sys(`${p.name} salió de la sala`);
    this.syncBots();
    this.boardDirty = true;
  }

  syncBots() {
    const humans = this.humanCount();
    const desired = humans > 0 ? Math.max(0, this.botFill - humans) : 0;
    let bots = this.botCount();
    while (bots > desired) {
      let last = null;
      for (const p of this.players.values()) if (p.isBot) last = p;
      this.players.delete(last.id);
      bots--;
    }
    while (bots < desired) {
      this.addBot();
      bots++;
    }
  }

  addBot() {
    const used = new Set();
    for (const p of this.players.values()) if (p.isBot) used.add(p.name);
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + this.nextPlayerId;
    const p = this.makePlayer({ name, color: COLORS[this.nextPlayerId % COLORS.length], isBot: true });
    this.players.set(p.id, p);
    this.spawn(p, this.now());
    return p;
  }

  pickSpawn() {
    const R = S.PLAYER_RADIUS;
    let best = null;
    let bestD = -1;
    for (let i = 0; i < 40; i++) {
      const x = 80 + Math.random() * (S.WORLD.w - 160);
      const y = 80 + Math.random() * (S.WORLD.h - 160);
      if (S.circleHitsObstacle(x, y, R + 16)) continue;
      let minD = Infinity;
      for (const o of this.players.values()) {
        if (o.alive) minD = Math.min(minD, Math.hypot(o.x - x, o.y - y));
      }
      if (minD > bestD) { bestD = minD; best = { x, y }; }
      if (minD > 600) break;
    }
    return best || { x: 120, y: 120 };
  }

  spawn(p, now) {
    const pos = this.pickSpawn();
    p.x = pos.x;
    p.y = pos.y;
    p.hp = CFG.maxHp;
    p.alive = true;
    p.protectedUntil = now + CFG.protectTime * 1000;
    p.rapidUntil = 0;
    p.cooldown = 0.3;
    p.budget = 0.1;
    p.queue.length = 0;
  }

  respawn(p, now) {
    this.spawn(p, now);
    this.fx.push([4, r1(p.x), r1(p.y)]);
    if (p.socket) p.socket.emit('respawn', {});
  }

  // ---------- entrada del jugador ----------
  // Cada input: [seq, dt, teclas, ángulo, disparo]
  pushInputs(p, arr) {
    if (!Array.isArray(arr)) return;
    const now = this.now();
    p.inputTokens = Math.min(60, p.inputTokens + ((now - p.inputTokensAt) / 1000) * 45);
    p.inputTokensAt = now;
    if (p.inputTokens < 1) return;
    p.inputTokens -= 1;
    const n = Math.min(arr.length, 12);
    for (let i = 0; i < n; i++) {
      const it = arr[i];
      if (!Array.isArray(it)) continue;
      const seq = it[0];
      const dt = it[1];
      const keys = it[2];
      const angle = it[3];
      const shoot = it[4];
      if (!Number.isSafeInteger(seq) || seq <= p.lastQueuedSeq) continue;
      if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) continue;
      if (!Number.isInteger(keys)) continue;
      if (typeof angle !== 'number' || !Number.isFinite(angle)) continue;
      p.lastQueuedSeq = seq;
      p.queue.push({ seq, dt: Math.min(dt, 0.05), keys: keys & 15, angle, shoot: shoot === 1 || shoot === true });
    }
    if (p.queue.length > 90) p.queue.splice(0, p.queue.length - 90);
  }

  processInputs(p, now, frozen) {
    // Presupuesto de tiempo: evita acelerar el movimiento mandando dt falsos.
    p.budget = Math.min(0.25, p.budget + DT * 1.15);
    const q = p.queue;
    for (let i = 0; i < q.length; i++) {
      const inp = q[i];
      p.lastInputAt = now;
      p.keys = inp.keys;
      p.angle = inp.angle;
      p.shoot = inp.shoot;
      if (p.alive && !frozen && p.budget >= inp.dt) {
        S.movePlayer(p, inp.keys, inp.dt);
        p.budget -= inp.dt;
      }
      p.seq = inp.seq;
    }
    q.length = 0;
    if (now - p.lastInputAt > 300) { // cliente en silencio: no seguir disparando
      p.keys = 0;
      p.shoot = false;
    }
  }

  chat(p, raw) {
    const now = this.now();
    if (now - p.lastChatAt < 700) return;
    const text = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    p.lastChatAt = now;
    this.emitRoom('chat', { id: p.id, n: p.name, c: p.color, t: text });
  }

  // ---------- simulación ----------
  step() {
    const now = this.now();
    const frozen = now < this.intermissionUntil;
    if (this.intermissionUntil && !frozen) this.resetRound(now);

    for (const p of this.players.values()) {
      if (!p.isBot) this.processInputs(p, now, frozen);
    }
    if (!frozen) {
      for (const p of this.players.values()) {
        p.cooldown = Math.max(0, p.cooldown - DT);
        if (!p.alive) {
          if (now >= p.respawnAt) this.respawn(p, now);
        } else if (p.isBot) {
          this.updateBot(p, now);
        }
      }
      this.shoot(now);
      this.updateBullets(now);
      this.updatePickups(now);
    }
    this.flush(now);
  }

  shoot(now) {
    for (const p of this.players.values()) {
      if (!p.alive || !p.shoot || p.cooldown > 0) continue;
      p.cooldown = now < p.rapidUntil ? CFG.rapidCooldown : CFG.fireCooldown;
      const c = Math.cos(p.angle);
      const s = Math.sin(p.angle);
      const off = S.PLAYER_RADIUS + 10;
      this.bullets.push({
        id: this.nextBulletId++, owner: p.id,
        x: p.x + c * off, y: p.y + s * off, a: p.angle,
        vx: c * S.BULLET_SPEED, vy: s * S.BULLET_SPEED, life: CFG.bulletLife,
      });
      this.totalShots++;
    }
  }

  updateBullets(now) {
    const SUB = 3;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (!b) continue;
      b.life -= DT;
      let dead = b.life <= 0;
      for (let s = 0; s < SUB && !dead; s++) {
        const px = b.x;
        const py = b.y;
        b.x += (b.vx * DT) / SUB;
        b.y += (b.vy * DT) / SUB;
        if (b.x < 0 || b.y < 0 || b.x > S.WORLD.w || b.y > S.WORLD.h || S.pointInObstacle(b.x, b.y)) {
          this.fx.push([0, r1(b.x), r1(b.y)]);
          dead = true;
          break;
        }
        for (const t of this.players.values()) {
          if (!t.alive || t.id === b.owner || now < t.protectedUntil) continue;
          if (S.segCircle(px, py, b.x, b.y, t.x, t.y, S.PLAYER_RADIUS + 3)) {
            this.damage(t, this.players.get(b.owner), CFG.bulletDamage, b.a, now);
            dead = true;
            break;
          }
        }
      }
      if (dead) this.bullets.splice(i, 1);
    }
  }

  damage(target, owner, dmg, angle, now) {
    target.hp -= dmg;
    this.fx.push([1, r1(target.x), r1(target.y)]);
    if (owner && owner.socket) owner.socket.emit('hitmark', target.hp <= 0 ? 1 : 0);
    if (target.socket) target.socket.emit('hurt', { a: r2(angle) });
    if (target.hp <= 0) this.kill(target, owner, now);
  }

  kill(victim, killer, now) {
    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    victim.shoot = false;
    victim.keys = 0;
    victim.respawnAt = now + CFG.respawnTime * 1000;
    if (killer && killer !== victim) killer.kills++;
    this.fx.push([2, r1(victim.x), r1(victim.y), victim.color]);
    this.emitRoom('kill', {
      k: killer ? killer.name : '?', kc: killer ? killer.color : '#888888', ki: killer ? killer.id : 0,
      v: victim.name, vc: victim.color, vi: victim.id,
    });
    if (victim.socket) victim.socket.emit('died', { by: killer ? killer.name : '?', ms: CFG.respawnTime * 1000 });
    this.boardDirty = true;
    if (killer && killer !== victim && killer.kills >= CFG.killLimit) this.endRound(killer, now);
  }

  endRound(winner, now) {
    this.intermissionUntil = now + CFG.intermission * 1000;
    this.bullets.length = 0;
    this.emitRoom('roundover', { n: winner.name, c: winner.color, ms: CFG.intermission * 1000 });
  }

  resetRound(now) {
    this.intermissionUntil = 0;
    this.bullets.length = 0;
    this.pickupActive.fill(true);
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.respawnAt = 0;
      this.spawn(p, now);
    }
    this.boardDirty = true;
    this.emitRoom('roundstart', {});
  }

  updatePickups(now) {
    for (let i = 0; i < S.PICKUPS.length; i++) {
      if (!this.pickupActive[i]) {
        if (now >= this.pickupAt[i]) this.pickupActive[i] = true;
        continue;
      }
      const k = S.PICKUPS[i];
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - k.x, p.y - k.y) > S.PLAYER_RADIUS + CFG.pickupRadius) continue;
        if (k.type === 'health') {
          if (p.hp >= CFG.maxHp) continue;
          p.hp = Math.min(CFG.maxHp, p.hp + CFG.healthAmount);
        } else {
          p.rapidUntil = now + CFG.rapidTime * 1000;
        }
        this.pickupActive[i] = false;
        this.pickupAt[i] = now + CFG.pickupRespawn * 1000;
        this.fx.push([3, k.x, k.y, k.type]);
        if (p.socket) p.socket.emit('pickup', { type: k.type, amount: CFG.healthAmount });
        break;
      }
    }
  }

  // ---------- bots ----------
  updateBot(p, now) {
    const ai = p.ai;
    if (now >= ai.retargetAt) {
      ai.retargetAt = now + 450 + Math.random() * 300;
      ai.aimErr = (Math.random() - 0.5) * 0.24;
      let best = null;
      let bd = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < bd) { bd = d; best = o; }
      }
      ai.target = best;
      ai.goal = null;
      if (p.hp < 45) { // herido: buscar botiquín
        let bk = null;
        let bkd = Infinity;
        S.PICKUPS.forEach((k, i) => {
          if (k.type !== 'health' || !this.pickupActive[i]) return;
          const d = Math.hypot(k.x - p.x, k.y - p.y);
          if (d < bkd) { bkd = d; bk = k; }
        });
        ai.goal = bk;
      }
      if (!best) {
        const a = Math.random() * Math.PI * 2;
        ai.wander = { x: Math.cos(a), y: Math.sin(a) };
      }
    }
    if (now >= ai.strafeAt) {
      ai.strafeAt = now + 800 + Math.random() * 900;
      ai.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    if (now >= ai.checkAt) { // detectar atascos contra paredes
      if (ai.wantMove && Math.hypot(p.x - ai.lx, p.y - ai.ly) < 8) {
        const a = Math.random() * Math.PI * 2;
        ai.unstuck = { x: Math.cos(a), y: Math.sin(a) };
        ai.unstuckUntil = now + 700;
      }
      ai.lx = p.x;
      ai.ly = p.y;
      ai.checkAt = now + 500;
    }

    let mx = 0;
    let my = 0;
    let shoot = false;
    const t = ai.target && ai.target.alive ? ai.target : null;
    if (t) {
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d;
      const ny = dy / d;
      p.angle = Math.atan2(dy, dx) + ai.aimErr;
      if (d > 420) { mx = nx; my = ny; } else if (d < 220) { mx = -nx; my = -ny; }
      mx += -ny * ai.strafeDir * 0.8;
      my += nx * ai.strafeDir * 0.8;
      if (d < 780 && !S.lineBlocked(p.x, p.y, t.x, t.y)) shoot = true;
    } else {
      mx = ai.wander.x;
      my = ai.wander.y;
      p.angle = Math.atan2(my, mx);
    }
    if (ai.goal) {
      const dx = ai.goal.x - p.x;
      const dy = ai.goal.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      mx = dx / d;
      my = dy / d;
    }
    if (now < ai.unstuckUntil) { mx = ai.unstuck.x; my = ai.unstuck.y; }

    ai.wantMove = Math.abs(mx) > 0.3 || Math.abs(my) > 0.3;
    let keys = 0;
    if (my < -0.3) keys |= S.KEY.UP;
    if (my > 0.3) keys |= S.KEY.DOWN;
    if (mx < -0.3) keys |= S.KEY.LEFT;
    if (mx > 0.3) keys |= S.KEY.RIGHT;
    p.keys = keys;
    p.shoot = shoot;
    S.movePlayer(p, keys, DT);
  }

  // ---------- red ----------
  flush(now) {
    if (this.fx.length) {
      this.emitRoom('fx', { t: now, e: this.fx });
      this.fx = [];
    }
    if (this.boardDirty && now - this.lastBoardAt > 250) {
      this.boardDirty = false;
      this.lastBoardAt = now;
      const list = [];
      for (const p of this.players.values()) {
        list.push({ id: p.id, n: p.name, c: p.color, k: p.kills, d: p.deaths, b: p.isBot ? 1 : 0 });
      }
      list.sort((a, b) => b.k - a.k || a.d - b.d);
      this.emitRoom('board', { list, limit: CFG.killLimit });
    }

    const ps = [];
    for (const p of this.players.values()) {
      let f = 0;
      if (p.alive) f |= 1;
      if (now < p.protectedUntil) f |= 2;
      if (now < p.rapidUntil) f |= 4;
      ps.push([p.id, r1(p.x), r1(p.y), r2(p.angle), Math.max(0, p.hp), f, p.seq]);
    }
    const bs = this.bullets.map((b) => [b.id, r1(b.x), r1(b.y), r2(b.a), b.owner]);
    let mask = 0;
    for (let i = 0; i < this.pickupActive.length; i++) if (this.pickupActive[i]) mask |= 1 << i;
    this.io.to(this.channel).volatile.emit('snap', { t: now, p: ps, b: bs, k: mask });
  }
}

Room.CFG = CFG;
module.exports = Room;
