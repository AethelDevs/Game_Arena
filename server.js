'use strict';
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const Room = require('./src/Room');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BOT_FILL = process.env.BOT_FILL !== undefined
  ? Math.max(0, parseInt(process.env.BOT_FILL, 10) || 0)
  : 4; // los bots rellenan la sala hasta este número de jugadores
const MAX_ROOMS = 50;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e4,
  perMessageDeflate: false,
  pingInterval: 10000,
  pingTimeout: 8000,
});

const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/shared.js', (req, res) => res.sendFile(path.join(__dirname, 'shared', 'shared.js')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/rooms', (req, res) => {
  const list = [...rooms.values()].map((r) => r.info()).sort((a, b) => b.players - a.players);
  res.json(list);
});

function sanitizeRoom(raw) {
  const id = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  return id || 'arena';
}

function leave(socket) {
  const room = socket.data.room;
  const player = socket.data.player;
  if (!room || !player) return;
  socket.leave(room.channel);
  room.removePlayer(player.id);
  socket.data.room = null;
  socket.data.player = null;
  if (room.humanCount() === 0) {
    room.stop();
    if (rooms.get(room.id) === room) rooms.delete(room.id);
  }
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.player = null;

  socket.on('join', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (socket.data.player) return reply({ ok: false, error: 'Ya estás dentro de una partida' });
      const d = data && typeof data === 'object' ? data : {};
      const roomId = sanitizeRoom(d.room);
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return reply({ ok: false, error: 'Servidor lleno, inténtalo más tarde' });
        room = new Room(roomId, io, { botFill: BOT_FILL });
        rooms.set(roomId, room);
        room.start();
      }
      if (room.humanCount() >= Room.CFG.maxPlayers) return reply({ ok: false, error: 'La sala está llena' });
      const player = room.addHuman(socket, d.name, d.color);
      socket.data.room = room;
      socket.data.player = player;
      reply({ ok: true, id: player.id, room: roomId, cfg: room.publicConfig() });
    } catch (err) {
      console.error('join error:', err);
      reply({ ok: false, error: 'Error interno del servidor' });
    }
  });

  socket.on('input', (arr) => {
    const { room, player } = socket.data;
    if (!room || !player) return;
    try { room.pushInputs(player, arr); } catch (err) { console.error('input error:', err); }
  });

  socket.on('chat', (text) => {
    const { room, player } = socket.data;
    if (!room || !player) return;
    try { room.chat(player, text); } catch (err) { console.error('chat error:', err); }
  });

  socket.on('ping', (cb) => { if (typeof cb === 'function') cb(); });

  socket.on('leave', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Arena Blaster escuchando en http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`  En tu red local:        http://${ni.address}:${PORT}`);
    }
  }
  console.log(`  Bots de relleno: ${BOT_FILL} (variable BOT_FILL)\n`);
});

function shutdown() {
  console.log('\nCerrando servidor…');
  for (const r of rooms.values()) r.stop();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
