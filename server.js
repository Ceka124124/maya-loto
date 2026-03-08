'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000, cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════
//  SABITLER
// ══════════════════════════════════════════
const BALL_MIN   = 0;
const BALL_MAX   = 101;   // 0..101  → 102 top
const BALL_TOTAL = BALL_MAX - BALL_MIN + 1;

const MAX_PLAYERS   = 12;
const TICKET_ROWS   = 3;
const TICKET_COLS   = 5;  // 3×5 = 15 hane → 15 farklı sayı
const TICKET_CELLS  = TICKET_ROWS * TICKET_COLS;

const DRAW_INTERVAL_MS = 5000;

const BONUSES = [
  { id: 'fast',   emoji: '⚡', label: 'HIZLI TUR',   desc: 'Toplar 2sn\'de bir çekilir!',         speed: 2000 },
  { id: 'double', emoji: '🎯', label: 'ÇİFT ÇEKİM',  desc: 'Her seferinde 2 top birden çıkar!',   speed: 5000 },
  { id: 'triple', emoji: '🔥', label: 'ÜÇ ÇEKİM',    desc: 'Bu turda 3 top birden çekilir!',      speed: 6000 },
  null, null, null, null  // %4/7 ihtimalle bonus çıkar
];

// ══════════════════════════════════════════
//  DURUM
// ══════════════════════════════════════════
function freshState() {
  return {
    phase:        'lobby',     // lobby | playing | finished
    round:        1,
    drawnBalls:   [],
    lastBall:     null,
    players:      {},          // sid → { name, color, tickets:[], marks:{}, rank:null, spectator:false }
    readySet:     new Set(),
    activeCount:  0,           // henüz kazanmamış oyuncu
    rankCounter:  0,           // 1. kazanan, 2. kazanan...
    bonus:        null,
    drawTimer:    null,
  };
}

let G = freshState();

// ══════════════════════════════════════════
//  YARDIMCILAR
// ══════════════════════════════════════════
const COLORS = [
  '#e67e22','#2980b9','#27ae60','#8e44ad',
  '#c0392b','#16a085','#d35400','#2c3e50',
  '#f39c12','#1abc9c','#6c3483','#117a65'
];
let colorIdx = 0;
function nextColor() { return COLORS[colorIdx++ % COLORS.length]; }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeTicket() {
  // 0-101 arası 15 unique sayı seç, 3×5 grid
  const pool = shuffle(Array.from({ length: BALL_TOTAL }, (_, i) => i + BALL_MIN));
  const nums  = pool.slice(0, TICKET_CELLS);
  nums.sort((a, b) => a - b); // satır içinde küçükten büyüğe sırala (okunması kolay)
  const grid = [];
  for (let r = 0; r < TICKET_ROWS; r++) {
    grid.push(nums.slice(r * TICKET_COLS, (r + 1) * TICKET_COLS));
  }
  return grid;
}

function publicState() {
  const pub = {};
  for (const [sid, p] of Object.entries(G.players)) {
    pub[sid] = {
      name:      p.name,
      color:     p.color,
      rank:      p.rank,
      spectator: p.spectator,
      ticketCount: p.tickets.length,
    };
  }
  return {
    phase:       G.phase,
    round:       G.round,
    drawnBalls:  G.drawnBalls,
    lastBall:    G.lastBall,
    players:     pub,
    readyCount:  G.readySet.size,
    totalCount:  Object.keys(G.players).length,
    activeCount: G.activeCount,
    rankCounter: G.rankCounter,
    bonus:       G.bonus,
  };
}

// ══════════════════════════════════════════
//  KAZANMA KONTROLÜ
// ══════════════════════════════════════════
function rowComplete(ticket, marks) {
  for (const row of ticket) {
    if (row.every(n => marks.includes(n))) return true;
  }
  return false;
}

function checkWins() {
  if (G.phase !== 'playing') return;
  const activePlayers = Object.entries(G.players).filter(([, p]) => !p.spectator);

  for (const [sid, p] of activePlayers) {
    for (let ti = 0; ti < p.tickets.length; ti++) {
      if (rowComplete(p.tickets[ti], p.marks[ti] || [])) {
        G.rankCounter++;
        p.rank      = G.rankCounter;
        p.spectator = true;
        G.activeCount--;

        io.emit('playerWon', {
          sid,
          name:        p.name,
          rank:        G.rankCounter,
          activeLeft:  G.activeCount,
          totalActive: activePlayers.length,
        });

        // Eğer 1 veya 0 aktif oyuncu kaldıysa oyun bitti
        if (G.activeCount <= 1) {
          // Son kişi otomatik son sıraya girer
          const lastActive = Object.entries(G.players).find(([, pp]) => !pp.spectator);
          if (lastActive) {
            G.rankCounter++;
            lastActive[1].rank      = G.rankCounter;
            lastActive[1].spectator = true;
            G.activeCount           = 0;
          }
          G.phase = 'finished';
          if (G.drawTimer) { clearInterval(G.drawTimer); G.drawTimer = null; }
          io.emit('gameFinished', { players: publicState().players });
        } else if (G.activeCount === 0) {
          G.phase = 'finished';
          if (G.drawTimer) { clearInterval(G.drawTimer); G.drawTimer = null; }
          io.emit('gameFinished', { players: publicState().players });
        }

        // Bir kişi kazandı, döngüyü kır; bir sonraki döngüde tekrar kontrol edilir
        return;
      }
    }
  }
}

// ══════════════════════════════════════════
//  TOP ÇEKME
// ══════════════════════════════════════════
function remaining() {
  return Array.from({ length: BALL_TOTAL }, (_, i) => i + BALL_MIN)
              .filter(n => !G.drawnBalls.includes(n));
}

function pickBall(pool) {
  if (!pool.length) return null;
  const idx = Math.floor(Math.random() * pool.length);
  const n   = pool.splice(idx, 1)[0];
  G.drawnBalls.push(n);
  G.lastBall = n;
  return n;
}

function doDraw() {
  if (G.phase !== 'playing') return;
  const pool = remaining();
  if (!pool.length) {
    G.phase = 'finished';
    clearInterval(G.drawTimer); G.drawTimer = null;
    io.emit('gameFinished', { players: publicState().players });
    return;
  }

  const bonus = G.bonus;
  const count = bonus?.id === 'double' ? 2 : bonus?.id === 'triple' ? 3 : 1;
  const drawn = [];
  for (let i = 0; i < count && pool.length; i++) {
    drawn.push(pickBall(pool));
  }

  io.emit('ballsDrawn', {
    balls:       drawn,
    lastBall:    drawn[drawn.length - 1],
    drawnBalls:  [...G.drawnBalls],
    bonus:       G.bonus,
  });

  checkWins();
}

function startDrawing() {
  if (G.drawTimer) clearInterval(G.drawTimer);
  const speed = G.bonus?.speed || DRAW_INTERVAL_MS;
  doDraw(); // ilk çekim hemen
  G.drawTimer = setInterval(doDraw, speed);
}

// ══════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════
io.on('connection', socket => {
  // Mevcut durumu gönder
  socket.emit('syncState', publicState());

  // ─── KATIL ────────────────────────────
  socket.on('joinGame', ({ name, ticketCount }) => {
    name = String(name || '').trim().slice(0, 18);
    if (!name) return socket.emit('joinError', 'Ad boş olamaz');

    const count = Math.max(1, Math.min(3, parseInt(ticketCount) || 1));
    const playerCount = Object.keys(G.players).length;
    if (playerCount >= MAX_PLAYERS) return socket.emit('joinError', 'Oda dolu (max 12)');

    const tickets = Array.from({ length: count }, makeTicket);
    const marks   = Object.fromEntries(tickets.map((_, i) => [String(i), []]));

    G.players[socket.id] = {
      name,
      color:     nextColor(),
      tickets,
      marks,
      rank:      null,
      spectator: false,
    };

    socket.emit('joinedOk', { tickets, marks });
    io.emit('syncState', publicState());
    io.emit('chatMsg', { system: true, text: `🎟️  ${name} oyuna katıldı!` });
  });

  // ─── HAZIR ────────────────────────────
  socket.on('ready', () => {
    if (!G.players[socket.id]) return;
    if (G.phase !== 'lobby') return;
    G.readySet.add(socket.id);

    const playerIds = Object.keys(G.players);
    io.emit('syncState', publicState());

    if (playerIds.length >= 2 && G.readySet.size >= playerIds.length) {
      G.phase       = 'playing';
      G.activeCount = playerIds.length;
      G.bonus       = BONUSES[Math.floor(Math.random() * BONUSES.length)];
      io.emit('gameStarted', { bonus: G.bonus });
      startDrawing();
    }
  });

  // ─── TAŞ KOY ──────────────────────────
  socket.on('mark', ({ ti, num }) => {
    const p = G.players[socket.id];
    if (!p) return;
    if (p.spectator) return socket.emit('markErr', 'İzleyici modu');
    if (G.phase !== 'playing') return socket.emit('markErr', 'Oyun aktif değil');
    if (!G.drawnBalls.includes(num)) return socket.emit('markErr', 'Top henüz çekilmedi');

    const tiStr = String(ti);
    if (!p.tickets[ti]) return;
    if (!p.tickets[ti].flat().includes(num)) return; // sayı bu bilette yok

    const marks = p.marks[tiStr] || [];
    const idx   = marks.indexOf(num);
    if (idx === -1) marks.push(num);
    else marks.splice(idx, 1);
    p.marks[tiStr] = marks;

    socket.emit('marked', { ti, marks: [...marks] });
    checkWins();
  });

  // ─── CHAT ─────────────────────────────
  socket.on('chat', ({ name, text }) => {
    if (!text || !text.trim()) return;
    io.emit('chatMsg', {
      system: false,
      name:   String(name).slice(0, 18),
      text:   String(text).trim().slice(0, 200),
      color:  G.players[socket.id]?.color || '#888',
    });
  });

  // ─── YENİ OYUN ────────────────────────
  socket.on('newGame', () => {
    if (G.drawTimer) clearInterval(G.drawTimer);
    G = freshState();
    colorIdx = 0;
    io.emit('gameReset');
    io.emit('syncState', publicState());
    io.emit('chatMsg', { system: true, text: '🔄 Yeni oyun başlatıldı!' });
  });

  // ─── AYRIL ────────────────────────────
  socket.on('disconnect', () => {
    const p = G.players[socket.id];
    if (!p) return;
    delete G.players[socket.id];
    G.readySet.delete(socket.id);
    if (!p.spectator) G.activeCount = Math.max(0, G.activeCount - 1);
    io.emit('syncState', publicState());
    io.emit('chatMsg', { system: true, text: `👋 ${p.name} ayrıldı` });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
