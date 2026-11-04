# Arena Blaster

Shooter multijugador de arena en tiempo real, hecho con **Node.js + Express + Socket.IO** y un cliente en HTML5 Canvas (sin frameworks ni build).

Gana quien llegue primero a **20 bajas**. Después de 8 segundos de marcador, empieza una ronda nueva.

## Cómo ejecutarlo

```bash
npm install
npm start
```

Abre `http://localhost:3000`. Para jugar con amigos en tu misma red, el servidor imprime al arrancar las direcciones `http://<tu-ip>:3000`. Para jugar por internet, despliégalo en cualquier hosting de Node (Render, Railway, Fly.io, un VPS…): usa la variable `PORT` y necesita WebSockets.

| Variable   | Por defecto | Qué hace |
|------------|-------------|----------|
| `PORT`     | `3000`      | Puerto HTTP/WebSocket |
| `BOT_FILL` | `4`         | Los bots rellenan cada sala hasta este número de jugadores (se van yendo cuando entran humanos). `0` los desactiva |

## Controles

- **WASD** o flechas: moverse
- **Ratón**: apuntar · **clic izquierdo**: disparar
- **Enter**: chat · **Tab** (mantener): marcador completo · **M**: silenciar

## Qué incluye

- **Salas**: escribe el nombre que quieras; se crean al entrar el primer jugador y se borran al quedar vacías (hasta 16 jugadores por sala, 50 salas). El menú lista las salas activas.
- **Servidor autoritativo** a 30 ticks/s: movimiento, balas, daño, colisiones y reglas se calculan solo en el servidor.
- **Predicción en el cliente + reconciliación** para tu propio movimiento (sin lag al moverte), e **interpolación** de los demás jugadores con 100 ms de retraso para que se vean fluidos.
- Obstáculos con colisión, **botiquines** (+40 de vida) y **rayos** (fuego rápido 8 s) que reaparecen a los 20 s.
- Reaparición con 2 s de escudo, kill feed, marcador, minimapa, chat, efectos de partículas, sonidos sintetizados y ping/FPS en pantalla.
- **Bots** con IA sencilla (perseguir, esquivar, buscar botiquín cuando están heridos) para poder jugar solo.
- **Anti-trampas básicas**: el servidor valida todos los datos que recibe, limita la tasa de mensajes, controla el "presupuesto de tiempo" de cada jugador (no se puede acelerar mandando `dt` falsos) y nunca confía en posiciones ni daño enviados por el cliente. El texto del chat y los nombres se muestran siempre como texto, nunca como HTML.

## Estructura

```
server.js          Express + Socket.IO, salas, límites y API (/api/rooms, /health)
src/Room.js        Lógica de una partida: física, balas, pickups, rondas, bots, snapshots
shared/shared.js   Mapa, constantes y movimiento (lo usan servidor y cliente: misma física)
public/            Cliente: index.html, style.css, client.js
test/              Pruebas (logic.js, smoke.js, client-vm.js)
```

### Protocolo (resumen)

| Evento | Dirección | Contenido |
|--------|-----------|-----------|
| `join` (con ack) | cliente → servidor | `{name, room, color}` → `{ok, id, room, cfg}` |
| `input` | cliente → servidor | lista de `[seq, dt, teclas, ángulo, disparo]` cada ~33 ms |
| `chat`, `ping`, `leave` | cliente → servidor | texto / ack / salir |
| `snap` | servidor → sala | `{t, p:[[id,x,y,áng,vida,flags,ackSeq]], b:[[id,x,y,áng,dueño]], k:máscaraPickups}` a 30 Hz |
| `fx`, `board`, `chat`, `kill`, `roundover`, `roundstart` | servidor → sala | efectos, marcador, mensajes, bajas, fin/inicio de ronda |
| `hurt`, `hitmark`, `died`, `respawn`, `pickup` | servidor → jugador | eventos personales |

## Ajustar el juego

Las constantes de reglas están en `src/Room.js` (`CFG`: daño, cadencia, vida, tiempos, bajas para ganar…) y el mapa, velocidad y radio en `shared/shared.js`.

## Pruebas

```bash
npm test
```

- `test/logic.js` — lógica del servidor sin red (física, disparos, kills, respawn, pickups, rondas, bots, anti-trampas).
- `test/smoke.js` — levanta el servidor real y conecta clientes Socket.IO (necesita `npm install`).
- `test/client-vm.js` — ejecuta `client.js` en un navegador simulado contra el servidor real (necesita `npm install`).
"# Game_Arena" 
