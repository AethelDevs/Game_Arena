(() => {
  'use strict';

  const S = window.Shared;
  const $ = (id) => document.getElementById(id);

  const INTERP_DELAY = 100;  // ms de retraso al dibujar a los demás (interpolación)
  const SEND_INTERVAL = 33;  // ms entre envíos de entrada
  const COLORS = ['#ff5d5d', '#ffb347', '#ffe66d', '#7bed9f', '#4dd0e1', '#5c9dff', '#b388ff', '#ff7eb6'];
  const R = S.PLAYER_RADIUS;

  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');

  const el = {
    menu: $('menu'), hud: $('hud'), name: $('name'), room: $('room'), rooms: $('rooms'), play: $('play'),
    error: $('menu-error'), swatches: $('swatches'),
    hpFill: $('hp-fill'), hpText: $('hp-text'), kdK: $('kd-k'), kdD: $('kd-d'),
    ping: $('ping'), fps: $('fps'), roomName: $('room-name'), power: $('powerup'),
    topBoard: $('top-board'), killfeed: $('killfeed'), toasts: $('toasts'),
    chat: $('chat'), chatLog: $('chat-log'), chatInput: $('chat-input'),
    hurt: $('hurt'), fullBoard: $('full-board'), fullBody: $('full-body'),
    death: $('death'), deathBy: $('death-by'), deathCount: $('death-count'),
    round: $('roundover'), roundWinner: $('round-winner'), roundCount: $('round-count'),
    leave: $('leave'),
  };

  const state = {
    socket: null, joined: false, myId: null, room: '',
    color: COLORS[4],
    me: { x: 0, y: 0, hp: 100, alive: false, flags: 0, angle: 0 },
    err: { x: 0, y: 0 },
    pending: [], outbox: [], seq: 0, lastSend: 0,
    snaps: [], offset: null,
    roster: new Map(),
    keys: 0, mouse: { x: 0, y: 0, down: false },
    typing: false, frozen: false,
    cam: { x: 0, y: 0 },
    particles: [], fxQueue: [],
    shake: 0, hitmark: 0, muzzle: 0, lastOwnBullet: 0,
    ping: 0, fps: 0, frames: 0, fpsAt: 0,
    deadUntil: 0, roundUntil: 0,
    audio: null, muted: false,
    shown: { hp: -1, k: -1, d: -1, power: null },
  };
  window.__arena = state;

  const view = { w: 0, h: 0, scale: 1, dpr: 1, vw: 0, vh: 0 };

  // ---------- utilidades ----------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
  }
  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function coloredSpan(text, color) {
    const s = mk('span', '', text);
    s.style.color = color || '#fff';
    return s;
  }
  function nameOf(id) { const r = state.roster.get(id); return r ? r.n : ''; }
  function colorOf(id) { const r = state.roster.get(id); return r ? r.c : '#ffffff'; }

  // ---------- audio ----------
  function initAudio() {
    if (state.audio) return;
    try { state.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { state.audio = null; }
  }
  function tone(f1, f2, dur, type, vol) {
    const a = state.audio;
    if (!a || state.muted) return;
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    shoot: () => tone(620, 140, 0.08, 'square', 0.035),
    hit: () => tone(900, 500, 0.06, 'triangle', 0.08),
    hurt: () => tone(160, 60, 0.18, 'sawtooth', 0.1),
    kill: () => { tone(440, 880, 0.2, 'triangle', 0.09); },
    pickup: () => tone(600, 1300, 0.16, 'sine', 0.08),
    die: () => tone(240, 40, 0.5, 'sawtooth', 0.12),
    respawn: () => tone(300, 700, 0.2, 'sine', 0.07),
  };

  // ---------- menú ----------
  function buildMenu() {
    try {
      el.name.value = localStorage.getItem('ab_name') || '';
      el.room.value = localStorage.getItem('ab_room') || 'arena';
      state.color = localStorage.getItem('ab_color') || state.color;
    } catch (e) { /* almacenamiento no disponible */ }
    el.swatches.textContent = '';
    COLORS.forEach((c) => {
      const s = mk('div', 'swatch' + (c === state.color ? ' sel' : ''));
      s.style.background = c;
      s.style.color = c;
      s.addEventListener('click', () => {
        state.color = c;
        for (const x of el.swatches.children) x.classList.remove('sel');
        s.classList.add('sel');
      });
      el.swatches.appendChild(s);
    });
    el.play.addEventListener('click', play);
    [el.name, el.room].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); }));
    refreshRooms();
    setInterval(() => { if (!state.joined) refreshRooms(); }, 3000);
  }

  function refreshRooms() {
    if (typeof fetch !== 'function') return;
    fetch('/api/rooms').then((r) => r.json()).then((list) => {
      el.rooms.textContent = '';
      if (!Array.isArray(list)) return;
      list.forEach((r) => {
        const chip = mk('div', 'room-chip', `${r.id} · ${r.players}/${r.max}`);
        chip.addEventListener('click', () => { el.room.value = r.id; });
        el.rooms.appendChild(chip);
      });
    }).catch(() => {});
  }

  function showError(msg) {
    el.error.textContent = msg || '';
    el.play.disabled = false;
  }

  function play() {
    initAudio();
    if (state.audio && state.audio.state === 'suspended') state.audio.resume();
    const name = el.name.value.trim();
    const room = el.room.value.trim() || 'arena';
    try {
      localStorage.setItem('ab_name', name);
      localStorage.setItem('ab_room', room);
      localStorage.setItem('ab_color', state.color);
    } catch (e) { /* ignorar */ }
    showError('');
    el.play.disabled = true;
    connect();
    state.socket.emit('join', { name, room, color: state.color }, (res) => {
      if (!res || !res.ok) { showError((res && res.error) || 'No se pudo entrar a la sala'); return; }
      resetSession(res);
    });
  }

  function resetSession(res) {
    state.myId = res.id;
    state.room = res.room;
    state.joined = true;
    state.frozen = false;
    state.pending = [];
    state.outbox = [];
    state.snaps = [];
    state.offset = null;
    state.particles = [];
    state.fxQueue = [];
    state.roster = new Map();
    state.lastOwnBullet = 0;
    state.deadUntil = 0;
    state.me.alive = false;
    state.err.x = state.err.y = 0;
    state.shown = { hp: -1, k: -1, d: -1, power: null };
    el.roomName.textContent = res.room;
    el.menu.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.death.classList.add('hidden');
    el.round.classList.add('hidden');
    el.chatLog.textContent = '';
    el.killfeed.textContent = '';
    document.body.classList.add('playing');
    el.play.disabled = false;
  }

  function backToMenu(msg) {
    state.joined = false;
    state.typing = false;
    state.keys = 0;
    state.mouse.down = false;
    document.body.classList.remove('playing');
    el.hud.classList.add('hidden');
    el.death.classList.add('hidden');
    el.round.classList.add('hidden');
    el.fullBoard.classList.add('hidden');
    el.hurt.classList.remove('on');
    el.chat.classList.remove('typing');
    el.menu.classList.remove('hidden');
    showError(msg || '');
    refreshRooms();
  }

  // ---------- red ----------
  function connect() {
    if (state.socket) return;
    const socket = io({ transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('snap', onSnapshot);
    socket.on('fx', (d) => { if (state.joined) state.fxQueue.push(d); });
    socket.on('board', onBoard);
    socket.on('chat', onChat);
    socket.on('kill', onKill);
    socket.on('hurt', () => {
      state.shake = Math.max(state.shake, 9);
      el.hurt.classList.add('on');
      setTimeout(() => el.hurt.classList.remove('on'), 60);
      sfx.hurt();
    });
    socket.on('hitmark', (k) => { state.hitmark = 0.25; (k ? sfx.kill : sfx.hit)(); });
    socket.on('died', (d) => {
      state.deadUntil = performance.now() + (d.ms || 3000);
      el.deathBy.textContent = d.by || '?';
      el.death.classList.remove('hidden');
      sfx.die();
    });
    socket.on('respawn', () => {
      state.deadUntil = 0;
      el.death.classList.add('hidden');
      sfx.respawn();
    });
    socket.on('pickup', (d) => {
      sfx.pickup();
      toast(d.type === 'health' ? `+${d.amount} vida` : '⚡ Fuego rápido', d.type === 'health' ? '#7bed9f' : '#ffe66d');
    });
    socket.on('roundover', (d) => {
      state.frozen = true;
      state.roundUntil = performance.now() + (d.ms || 8000);
      el.roundWinner.textContent = d.n;
      el.roundWinner.style.color = d.c;
      el.round.classList.remove('hidden');
      el.death.classList.add('hidden');
    });
    socket.on('roundstart', () => {
      state.frozen = false;
      state.roundUntil = 0;
      el.round.classList.add('hidden');
      toast('¡Nueva ronda!', '#4dd0e1');
    });
    socket.on('disconnect', () => {
      state.socket = null;
      if (state.joined) backToMenu('Conexión perdida con el servidor');
      try { socket.close(); } catch (e) { /* ya cerrado */ }
    });

    setInterval(() => {
      if (state.socket !== socket || !socket.connected) return;
      const t0 = performance.now();
      socket.emit('ping', () => {
        const rtt = performance.now() - t0;
        state.ping = state.ping ? state.ping * 0.6 + rtt * 0.4 : rtt;
      });
    }, 2000);
  }

  function onSnapshot(s) {
    if (!state.joined) return;
    const now = performance.now();
    const est = s.t - now;
    state.offset = state.offset === null ? est : state.offset * 0.95 + est * 0.05;
    s.pm = new Map(s.p.map((e) => [e[0], e]));
    s.bm = new Map(s.b.map((e) => [e[0], e]));
    state.snaps.push(s);
    while (state.snaps.length > 40) state.snaps.shift();

    // Sonido y fogonazo al aparecer una bala propia nueva
    let maxOwn = state.lastOwnBullet;
    for (const e of s.b) {
      if (e[4] === state.myId && e[0] > state.lastOwnBullet) {
        if (e[0] > maxOwn) maxOwn = e[0];
        state.muzzle = 0.06;
        sfx.shoot();
      }
    }
    state.lastOwnBullet = maxOwn;

    const mine = s.pm.get(state.myId);
    if (mine) reconcile(mine);
  }

  // Reconciliación: partir de la posición del servidor y reaplicar las entradas aún no confirmadas
  function reconcile(e) {
    const me = state.me;
    const wasAlive = me.alive;
    me.hp = e[4];
    me.flags = e[5];
    me.alive = !!(e[5] & 1);
    const ack = e[6];
    while (state.pending.length && state.pending[0][0] <= ack) state.pending.shift();
    if (!me.alive || state.frozen) {
      me.x = e[1];
      me.y = e[2];
      state.err.x = state.err.y = 0;
      return;
    }
    const tmp = { x: e[1], y: e[2] };
    for (const inp of state.pending) S.movePlayer(tmp, inp[2], inp[1]);
    const ex = me.x - tmp.x;
    const ey = me.y - tmp.y;
    me.x = tmp.x;
    me.y = tmp.y;
    if (!wasAlive || Math.hypot(ex, ey) > 120) {
      state.err.x = state.err.y = 0;
    } else {
      state.err.x += ex; // el error se disipa suavemente al dibujar
      state.err.y += ey;
    }
  }

  function onBoard(d) {
    state.roster = new Map(d.list.map((r) => [r.id, r]));
    el.topBoard.textContent = '';
    el.topBoard.appendChild(mk('div', 'title', `Marcador · meta ${d.limit}`));
    d.list.slice(0, 5).forEach((r) => {
      const row = mk('div', 'row' + (r.id === state.myId ? ' me' : ''));
      const n = coloredSpan(r.n, r.c);
      n.className = 'n';
      row.appendChild(n);
      row.appendChild(mk('span', '', String(r.k)));
      el.topBoard.appendChild(row);
    });
    const mine = state.roster.get(state.myId);
    if (mine) {
      if (state.shown.k !== mine.k) { el.kdK.textContent = mine.k; state.shown.k = mine.k; }
      if (state.shown.d !== mine.d) { el.kdD.textContent = mine.d; state.shown.d = mine.d; }
    }
    if (!el.fullBoard.classList.contains('hidden')) renderFullBoard();
  }

  function renderFullBoard() {
    el.fullBody.textContent = '';
    const list = [...state.roster.values()].sort((a, b) => b.k - a.k || a.d - b.d);
    list.forEach((r, i) => {
      const tr = mk('tr', r.id === state.myId ? 'me' : '');
      tr.appendChild(mk('td', '', String(i + 1)));
      const td = mk('td');
      td.appendChild(coloredSpan(r.n + (r.b ? ' 🤖' : ''), r.c));
      tr.appendChild(td);
      tr.appendChild(mk('td', '', String(r.k)));
      tr.appendChild(mk('td', '', String(r.d)));
      el.fullBody.appendChild(tr);
    });
  }

  function onChat(m) {
    const row = mk('div', 'msg' + (m.s ? ' sys' : ''));
    if (m.s) {
      row.textContent = m.t;
    } else {
      row.appendChild(coloredSpan(m.n + ': ', m.c));
      row.appendChild(mk('span', '', m.t));
    }
    row.dataset.t = String(Date.now());
    el.chatLog.appendChild(row);
    while (el.chatLog.children.length > 40) el.chatLog.removeChild(el.chatLog.firstChild);
  }

  function onKill(k) {
    const row = mk('div', 'kf' + (k.ki === state.myId ? ' mine' : ''));
    row.appendChild(coloredSpan(k.k, k.kc));
    row.appendChild(mk('span', 'x', '✕'));
    row.appendChild(coloredSpan(k.v, k.vc));
    el.killfeed.appendChild(row);
    setTimeout(() => row.remove(), 5000);
    while (el.killfeed.children.length > 6) el.killfeed.removeChild(el.killfeed.firstChild);
    if (k.ki === state.myId && k.vi !== state.myId) toast(`Eliminaste a ${k.v}`, '#ffe66d');
  }

  function toast(text, color) {
    const t = mk('div', 'toast', text);
    t.style.color = color || '#fff';
    el.toasts.appendChild(t);
    setTimeout(() => t.remove(), 1600);
    while (el.toasts.children.length > 3) el.toasts.removeChild(el.toasts.firstChild);
  }

  // ---------- efectos ----------
  function burst(x, y, color, n, speed, life, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      state.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.6 + Math.random() * 0.8), ring: false });
    }
  }
  function ring(x, y, color) {
    state.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, color, size: 18, ring: true });
  }
  function spawnFx(e) {
    const kind = e[0];
    const x = e[1];
    const y = e[2];
    if (kind === 0) burst(x, y, '#cfd8ff', 5, 170, 0.3, 2);
    else if (kind === 1) burst(x, y, '#ff5d5d', 9, 210, 0.35, 3);
    else if (kind === 2) { burst(x, y, e[3] || '#ff9f43', 30, 330, 0.75, 4); burst(x, y, '#ffffff', 10, 240, 0.4, 2); ring(x, y, e[3] || '#ff9f43'); }
    else if (kind === 3) { ring(x, y, e[3] === 'health' ? '#7bed9f' : '#ffe66d'); burst(x, y, e[3] === 'health' ? '#7bed9f' : '#ffe66d', 12, 180, 0.5, 3); }
    else if (kind === 4) ring(x, y, '#4dd0e1');
  }

  // ---------- entrada ----------
  const KEYMAP = {
    KeyW: S.KEY.UP, ArrowUp: S.KEY.UP,
    KeyS: S.KEY.DOWN, ArrowDown: S.KEY.DOWN,
    KeyA: S.KEY.LEFT, ArrowLeft: S.KEY.LEFT,
    KeyD: S.KEY.RIGHT, ArrowRight: S.KEY.RIGHT,
  };

  function openChat() {
    state.typing = true;
    state.keys = 0;
    el.chat.classList.add('typing');
    el.chatInput.value = '';
    el.chatInput.focus();
  }
  function closeChat() {
    state.typing = false;
    el.chat.classList.remove('typing');
    el.chatInput.blur();
  }

  function bindInput() {
    window.addEventListener('keydown', (e) => {
      initAudio();
      if (!state.joined || state.typing) return;
      if (e.code === 'Enter') { e.preventDefault(); openChat(); return; }
      if (e.code === 'Tab') {
        e.preventDefault();
        renderFullBoard();
        el.fullBoard.classList.remove('hidden');
        return;
      }
      if (e.code === 'KeyM') { state.muted = !state.muted; toast(state.muted ? 'Sonido apagado' : 'Sonido activado', '#8fa0c8'); return; }
      const bit = KEYMAP[e.code];
      if (bit) { state.keys |= bit; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') { el.fullBoard.classList.add('hidden'); return; }
      const bit = KEYMAP[e.code];
      if (bit) state.keys &= ~bit;
    });
    window.addEventListener('blur', () => { state.keys = 0; state.mouse.down = false; });
    window.addEventListener('mousemove', (e) => { state.mouse.x = e.clientX; state.mouse.y = e.clientY; });
    canvas.addEventListener('mousedown', (e) => { initAudio(); if (e.button === 0) state.mouse.down = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) state.mouse.down = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        const text = el.chatInput.value.trim();
        if (text && state.socket) state.socket.emit('chat', text);
        closeChat();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closeChat();
      }
    });
    el.leave.addEventListener('click', () => {
      if (state.socket) state.socket.emit('leave');
      backToMenu('');
    });
    setInterval(() => { // desvanecer mensajes viejos del chat
      const now = Date.now();
      for (const m of el.chatLog.children) {
        if (now - Number(m.dataset.t || 0) > 9000) m.classList.add('faded');
      }
    }, 1000);
  }

  // ---------- bucle principal ----------
  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    canvas.width = Math.floor(view.w * view.dpr);
    canvas.height = Math.floor(view.h * view.dpr);
    canvas.style.width = view.w + 'px';
    canvas.style.height = view.h + 'px';
    view.scale = Math.min(view.w / 1400, view.h / 800); // campo de visión mínimo 1400x800
    view.vw = view.w / view.scale;
    view.vh = view.h / view.scale;
  }

  function updateCamera() {
    const me = state.me;
    const px = me.x + state.err.x;
    const py = me.y + state.err.y;
    state.cam.x = view.vw >= S.WORLD.w ? (S.WORLD.w - view.vw) / 2 : clamp(px - view.vw / 2, 0, S.WORLD.w - view.vw);
    state.cam.y = view.vh >= S.WORLD.h ? (S.WORLD.h - view.vh) / 2 : clamp(py - view.vh / 2, 0, S.WORLD.h - view.vh);
  }

  function update(dt) {
    const me = state.me;
    if (state.joined) {
      // Apuntar: ángulo desde el jugador (en pantalla) hacia el ratón
      const sx = (me.x + state.err.x - state.cam.x) * view.scale;
      const sy = (me.y + state.err.y - state.cam.y) * view.scale;
      me.angle = Math.atan2(state.mouse.y - sy, state.mouse.x - sx);

      const keys = state.typing ? 0 : state.keys;
      const shoot = state.mouse.down && !state.typing ? 1 : 0;
      const inp = [++state.seq, Math.round(dt * 10000) / 10000, keys, Math.round(me.angle * 1000) / 1000, shoot];
      if (me.alive && !state.frozen) S.movePlayer(me, keys, dt); // predicción local
      state.pending.push(inp);
      if (state.pending.length > 120) state.pending.shift();
      state.outbox.push(inp);
      const now = performance.now();
      if (now - state.lastSend >= SEND_INTERVAL && state.socket) {
        state.socket.emit('input', state.outbox);
        state.outbox = [];
        state.lastSend = now;
      }
      if (state.outbox.length > 30) state.outbox.splice(0, state.outbox.length - 30);

      const k = Math.exp(-dt * 12);
      state.err.x *= k;
      state.err.y *= k;

      // efectos sincronizados con el tiempo de render
      if (state.offset !== null) {
        const renderT = now + state.offset - INTERP_DELAY;
        while (state.fxQueue.length && state.fxQueue[0].t <= renderT) {
          state.fxQueue.shift().e.forEach(spawnFx);
        }
      }
    }
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.life -= dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      const f = Math.max(0, 1 - 3 * dt);
      p.vx *= f;
      p.vy *= f;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    state.shake = Math.max(0, state.shake - dt * 30);
    state.hitmark = Math.max(0, state.hitmark - dt);
    state.muzzle = Math.max(0, state.muzzle - dt);
    updateCamera();
    updateHud();
  }

  function updateHud() {
    if (!state.joined) return;
    const hp = Math.round(state.me.hp);
    if (state.shown.hp !== hp) {
      state.shown.hp = hp;
      el.hpFill.style.width = clamp(hp, 0, 100) + '%';
      el.hpFill.style.background = hp > 60 ? '#7bed9f' : hp > 30 ? '#ffb347' : '#ff5d5d';
      el.hpText.textContent = String(hp);
    }
    const rapid = !!(state.me.flags & 4);
    if (state.shown.power !== rapid) {
      state.shown.power = rapid;
      el.power.classList.toggle('hidden', !rapid);
    }
    const now = performance.now();
    if (state.deadUntil) el.deathCount.textContent = String(Math.max(0, Math.ceil((state.deadUntil - now) / 1000)));
    if (state.roundUntil) el.roundCount.textContent = String(Math.max(0, Math.ceil((state.roundUntil - now) / 1000)));
    state.frames++;
    if (now - state.fpsAt >= 1000) {
      el.fps.textContent = state.frames + ' fps';
      el.ping.textContent = Math.round(state.ping) + ' ms';
      state.frames = 0;
      state.fpsAt = now;
    }
  }

  // ---------- muestreo / interpolación ----------
  function sample(renderT) {
    const sn = state.snaps;
    if (!sn.length) return null;
    const last = sn[sn.length - 1];
    let a;
    let b;
    let alpha = 0;
    if (renderT >= last.t) { a = b = last; }
    else if (renderT <= sn[0].t) { a = b = sn[0]; }
    else {
      let j = sn.length - 2;
      while (j > 0 && sn[j].t > renderT) j--;
      a = sn[j];
      b = sn[j + 1];
      alpha = (renderT - a.t) / Math.max(1, b.t - a.t);
    }
    const players = [];
    for (const e of b.p) {
      if (e[0] === state.myId) continue;
      let ea = a.pm.get(e[0]) || e;
      if (Math.hypot(e[1] - ea[1], e[2] - ea[2]) > 300) ea = e; // teletransporte (reaparición)
      players.push({
        id: e[0], x: ea[1] + (e[1] - ea[1]) * alpha, y: ea[2] + (e[2] - ea[2]) * alpha,
        a: lerpAngle(ea[3], e[3], alpha), hp: e[4], f: e[5],
      });
    }
    const bullets = [];
    for (const e of b.b) {
      if (e[4] === state.myId) continue;
      const ea = a.bm.get(e[0]);
      let x;
      let y;
      if (ea) {
        x = ea[1] + (e[1] - ea[1]) * alpha;
        y = ea[2] + (e[2] - ea[2]) * alpha;
      } else {
        const back = Math.max(0, (b.t - renderT) / 1000) * S.BULLET_SPEED;
        x = e[1] - Math.cos(e[3]) * back;
        y = e[2] - Math.sin(e[3]) * back;
      }
      bullets.push({ x, y, a: e[3], own: false });
    }
    // Balas propias: sin retraso, extrapoladas desde el último snapshot
    const ext = clamp((performance.now() + state.offset - last.t) / 1000, 0, 0.12);
    for (const e of last.b) {
      if (e[4] !== state.myId) continue;
      bullets.push({
        x: e[1] + Math.cos(e[3]) * S.BULLET_SPEED * ext,
        y: e[2] + Math.sin(e[3]) * S.BULLET_SPEED * ext,
        a: e[3], own: true,
      });
    }
    return { players, bullets, mask: last.k };
  }

  // ---------- dibujo ----------
  function drawPlayer(x, y, angle, color, name, hp, flags, isMe, t) {
    ctx.save();
    ctx.translate(x, y);
    if (flags & 2) { // escudo de reaparición
      ctx.beginPath();
      ctx.arc(0, 0, R + 9 + Math.sin(t / 120) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120, 230, 255, 0.85)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    if (flags & 4) { // fuego rápido
      ctx.beginPath();
      ctx.arc(0, 0, R + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 230, 109, 0.22)';
      ctx.fill();
    }
    ctx.rotate(angle);
    ctx.fillStyle = '#1b2236';
    ctx.fillRect(R - 8, -5, 26, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(R - 8, -5, 26, 10);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = isMe ? 4 : 3;
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.restore();

    // barra de vida y nombre
    const w = 44;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y - R - 16, w, 6);
    ctx.fillStyle = hp > 60 ? '#7bed9f' : hp > 30 ? '#ffb347' : '#ff5d5d';
    ctx.fillRect(x - w / 2, y - R - 16, (w * clamp(hp, 0, 100)) / 100, 6);
    if (name) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(name, x, y - R - 22);
      ctx.fillText(name, x, y - R - 22);
    }
  }

  function drawWorld(frame, t) {
    const cam = state.cam;
    const sx = (Math.random() - 0.5) * state.shake;
    const sy = (Math.random() - 0.5) * state.shake;
    const k = view.dpr * view.scale;
    ctx.setTransform(k, 0, 0, k, (-cam.x + sx) * k, (-cam.y + sy) * k);

    // suelo y cuadrícula
    ctx.fillStyle = '#0e1630';
    ctx.fillRect(0, 0, S.WORLD.w, S.WORLD.h);
    ctx.strokeStyle = 'rgba(120, 150, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(cam.x / 100) * 100);
    const x1 = Math.min(S.WORLD.w, cam.x + view.vw + 100);
    const y0 = Math.max(0, Math.floor(cam.y / 100) * 100);
    const y1 = Math.min(S.WORLD.h, cam.y + view.vh + 100);
    for (let x = x0; x <= x1; x += 100) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += 100) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(77, 208, 225, 0.8)';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, S.WORLD.w, S.WORLD.h);

    // botiquines y power-ups
    S.PICKUPS.forEach((p, i) => {
      const active = !!(frame.mask & (1 << i));
      const col = p.type === 'health' ? '#7bed9f' : '#ffe66d';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      if (!active) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }
      const pulse = 1 + Math.sin(t / 250 + i) * 0.08;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(pulse, pulse);
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.fillStyle = col;
      if (p.type === 'health') {
        ctx.fillRect(-9, -3, 18, 6);
        ctx.fillRect(-3, -9, 6, 18);
      } else {
        ctx.beginPath();
        ctx.moveTo(3, -11); ctx.lineTo(-7, 2); ctx.lineTo(-1, 2);
        ctx.lineTo(-3, 11); ctx.lineTo(7, -3); ctx.lineTo(1, -3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });

    // obstáculos
    for (const o of S.OBSTACLES) {
      ctx.fillStyle = '#1c2748';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#5b78d6';
      ctx.lineWidth = 3;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(o.x + 4, o.y + 4, o.w - 8, Math.min(10, o.h - 8));
    }

    // balas
    for (const b of frame.bullets) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.own ? 'rgba(255, 240, 160, 0.35)' : 'rgba(255, 150, 150, 0.35)';
      ctx.fillRect(-26, -2.5, 26, 5);
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = b.own ? '#fff3b0' : '#ffd0d0';
      ctx.fill();
      ctx.restore();
    }

    // jugadores
    for (const p of frame.players) {
      if (!(p.f & 1)) continue;
      drawPlayer(p.x, p.y, p.a, colorOf(p.id), nameOf(p.id), p.hp, p.f, false, t);
    }
    const me = state.me;
    if (me.alive) {
      const mx = me.x + state.err.x;
      const my = me.y + state.err.y;
      drawPlayer(mx, my, me.angle, state.color, '', me.hp, me.flags, true, t);
      if (state.muzzle > 0) {
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(me.angle);
        ctx.beginPath();
        ctx.arc(R + 20, 0, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 240, 160, 0.9)';
        ctx.fill();
        ctx.restore();
      }
    }

    // partículas
    for (const p of state.particles) {
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      if (p.ring) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + (1 - a) * 60, 0, Math.PI * 2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 4 * a + 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // retícula y marcador de impacto (coordenadas de pantalla)
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const cx = state.mouse.x;
    const cy = state.mouse.y;
    ctx.strokeStyle = state.hitmark > 0 ? '#ff5d5d' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.moveTo(cx - 16, cy); ctx.lineTo(cx - 6, cy);
    ctx.moveTo(cx + 6, cy); ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy - 6);
    ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 16);
    ctx.stroke();
    if (state.hitmark > 0) {
      ctx.strokeStyle = '#ff5d5d';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy - 9); ctx.lineTo(cx - 15, cy - 15);
      ctx.moveTo(cx + 9, cy - 9); ctx.lineTo(cx + 15, cy - 15);
      ctx.moveTo(cx - 9, cy + 9); ctx.lineTo(cx - 15, cy + 15);
      ctx.moveTo(cx + 9, cy + 9); ctx.lineTo(cx + 15, cy + 15);
      ctx.stroke();
    }
  }

  function drawMinimap(frame) {
    const w = mini.width;
    const h = mini.height;
    const sx = w / S.WORLD.w;
    const sy = h / S.WORLD.h;
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = 'rgba(8,12,28,0.85)';
    mctx.fillRect(0, 0, w, h);
    mctx.fillStyle = '#35467f';
    for (const o of S.OBSTACLES) mctx.fillRect(o.x * sx, o.y * sy, Math.max(2, o.w * sx), Math.max(2, o.h * sy));
    S.PICKUPS.forEach((p, i) => {
      if (!(frame.mask & (1 << i))) return;
      mctx.fillStyle = p.type === 'health' ? '#7bed9f' : '#ffe66d';
      mctx.fillRect(p.x * sx - 2, p.y * sy - 2, 4, 4);
    });
    for (const p of frame.players) {
      if (!(p.f & 1)) continue;
      mctx.fillStyle = '#ff6b6b';
      mctx.beginPath();
      mctx.arc(p.x * sx, p.y * sy, 3, 0, Math.PI * 2);
      mctx.fill();
    }
    if (state.me.alive) {
      mctx.strokeStyle = '#ffffff';
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc((state.me.x + state.err.x) * sx, (state.me.y + state.err.y) * sy, 4, 0, Math.PI * 2);
      mctx.stroke();
    }
    mctx.strokeStyle = 'rgba(255,255,255,0.25)';
    mctx.lineWidth = 1;
    mctx.strokeRect(state.cam.x * sx, state.cam.y * sy, view.vw * sx, view.vh * sy);
  }

  function render(t) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#070b16';
    ctx.fillRect(0, 0, view.w, view.h);
    if (!state.joined) return;
    const renderT = performance.now() + (state.offset || 0) - INTERP_DELAY;
    const frame = sample(renderT) || { players: [], bullets: [], mask: 0 };
    drawWorld(frame, t);
    drawMinimap(frame);
  }

  let lastTs = 0;
  function loop(ts) {
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    update(dt);
    render(ts);
    requestAnimationFrame(loop);
  }

  // ---------- arranque ----------
  buildMenu();
  bindInput();
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(loop);
})();
