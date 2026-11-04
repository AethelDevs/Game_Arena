'use strict';
/*
 * Código compartido entre servidor y cliente: constantes, mapa y física de movimiento.
 * El servidor es la autoridad; el cliente usa esto para predecir su propio movimiento.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WORLD = { w: 2400, h: 1600 };
  const PLAYER_RADIUS = 20;
  const PLAYER_SPEED = 270; // px/s
  const BULLET_SPEED = 950; // px/s
  const KEY = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8 };

  // Mapa simétrico respecto al centro (1200, 800)
  const OBSTACLES = [
    { x: 1100, y: 700, w: 200, h: 200 }, // bloque central
    { x: 450, y: 300, w: 200, h: 200 },  // pilares
    { x: 1750, y: 300, w: 200, h: 200 },
    { x: 450, y: 1100, w: 200, h: 200 },
    { x: 1750, y: 1100, w: 200, h: 200 },
    { x: 900, y: 220, w: 150, h: 50 },   // muros superior / inferior
    { x: 1350, y: 220, w: 150, h: 50 },
    { x: 900, y: 1330, w: 150, h: 50 },
    { x: 1350, y: 1330, w: 150, h: 50 },
    { x: 150, y: 700, w: 60, h: 200 },   // muros laterales
    { x: 2190, y: 700, w: 60, h: 200 },
    { x: 820, y: 620, w: 40, h: 360 },   // muros interiores
    { x: 1540, y: 620, w: 40, h: 360 },
    { x: 600, y: 770, w: 60, h: 60 },    // cajas
    { x: 1740, y: 770, w: 60, h: 60 },
  ];

  const PICKUPS = [
    { x: 1200, y: 550, type: 'health' },
    { x: 1200, y: 1050, type: 'health' },
    { x: 300, y: 800, type: 'health' },
    { x: 2100, y: 800, type: 'health' },
    { x: 1200, y: 250, type: 'health' },
    { x: 1200, y: 1350, type: 'health' },
    { x: 700, y: 550, type: 'rapid' },
    { x: 1700, y: 550, type: 'rapid' },
    { x: 700, y: 1050, type: 'rapid' },
    { x: 1700, y: 1050, type: 'rapid' },
  ];

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function resolveCircleRect(p, o, r) {
    const cx = clamp(p.x, o.x, o.x + o.w);
    const cy = clamp(p.y, o.y, o.y + o.h);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const push = r - d;
      p.x += (dx / d) * push;
      p.y += (dy / d) * push;
    } else {
      // El centro está dentro del rectángulo: salir por el lado más cercano
      const l = p.x - o.x;
      const rt = o.x + o.w - p.x;
      const t = p.y - o.y;
      const b = o.y + o.h - p.y;
      const m = Math.min(l, rt, t, b);
      if (m === l) p.x = o.x - r;
      else if (m === rt) p.x = o.x + o.w + r;
      else if (m === t) p.y = o.y - r;
      else p.y = o.y + o.h + r;
    }
  }

  // Mueve un jugador ({x, y}) según las teclas durante dt segundos.
  function movePlayer(p, keys, dt) {
    const dx = ((keys & KEY.RIGHT) ? 1 : 0) - ((keys & KEY.LEFT) ? 1 : 0);
    const dy = ((keys & KEY.DOWN) ? 1 : 0) - ((keys & KEY.UP) ? 1 : 0);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      p.x += (dx / len) * PLAYER_SPEED * dt;
      p.y += (dy / len) * PLAYER_SPEED * dt;
    }
    const R = PLAYER_RADIUS;
    p.x = clamp(p.x, R, WORLD.w - R);
    p.y = clamp(p.y, R, WORLD.h - R);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < OBSTACLES.length; j++) resolveCircleRect(p, OBSTACLES[j], R);
    }
    p.x = clamp(p.x, R, WORLD.w - R);
    p.y = clamp(p.y, R, WORLD.h - R);
  }

  function pointInObstacle(x, y) {
    for (let i = 0; i < OBSTACLES.length; i++) {
      const o = OBSTACLES[i];
      if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return true;
    }
    return false;
  }

  function circleHitsObstacle(x, y, r) {
    for (let i = 0; i < OBSTACLES.length; i++) {
      const o = OBSTACLES[i];
      const cx = clamp(x, o.x, o.x + o.w);
      const cy = clamp(y, o.y, o.y + o.h);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  // ¿Hay un obstáculo entre dos puntos? (muestreo cada ~16 px)
  function lineBlocked(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 16));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (pointInObstacle(x1 + dx * t, y1 + dy * t)) return true;
    }
    return false;
  }

  // ¿El segmento (x1,y1)-(x2,y2) toca el círculo (cx,cy,r)?
  function segCircle(x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const px = x1 + dx * t - cx;
    const py = y1 + dy * t - cy;
    return px * px + py * py <= r * r;
  }

  return {
    WORLD, PLAYER_RADIUS, PLAYER_SPEED, BULLET_SPEED, KEY, OBSTACLES, PICKUPS,
    clamp, movePlayer, pointInObstacle, circleHitsObstacle, lineBlocked, segCircle,
  };
});
