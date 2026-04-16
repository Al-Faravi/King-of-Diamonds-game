const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory game store ──────────────────────────────────────────────────
const games = {}; // gameCode → GameState

function genCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function genId() {
  return Math.random().toString(36).substr(2, 9);
}

// ─── Game State Factory ────────────────────────────────────────────────────
function createGame(hostId, hostName) {
  const code = genCode();
  return {
    code,
    hostId,
    phase: 'waiting',   // waiting | playing | round_result | finished
    round: 0,
    eliminations: 0,
    players: {
      [hostId]: {
        id: hostId,
        name: hostName,
        score: 0,
        eliminated: false,
        isHost: true,
        isAI: false,
        socketId: null
      }
    },
    submissions: {},      // playerId → number
    roundResult: null,
    log: [],
    timerTimeout: null,
    roundTimerEnd: null   // timestamp when timer expires
  };
}

// ─── Rule helpers ──────────────────────────────────────────────────────────
// Returns how many special rules are active based on total eliminations so far
// Rule A: elim >= 1  → duplicate number invalid
// Rule B: elim >= 2  → exact match → others -2
// Rule C: elim >= 3  → 0 vs 100: 100 wins
function getActiveRules(eliminations) {
  return {
    ruleA: eliminations >= 1,
    ruleB: eliminations >= 2,
    ruleC: eliminations >= 3
  };
}

// Time limit: 5 min if first round or first round after new rule; else 60s
function getRoundTimeLimit(gs) {
  // Round 1 always 5 min
  if (gs.round === 1) return 300;
  // First round after each new elimination (rule change)
  if (gs._isFirstRoundAfterNewRule) return 300;
  return 60;
}

// ─── Core game logic ───────────────────────────────────────────────────────
function resolveRound(gs) {
  const active = Object.values(gs.players).filter(p => !p.eliminated);
  const elim = gs.eliminations;
  const rules = getActiveRules(elim);

  // Collect numbers (auto-random if not submitted)
  const numbers = {};
  active.forEach(p => {
    numbers[p.id] = gs.submissions[p.id] !== undefined
      ? gs.submissions[p.id]
      : Math.floor(Math.random() * 101);
  });

  // Count duplicates
  const countMap = {};
  Object.values(numbers).forEach(v => {
    countMap[v] = (countMap[v] || 0) + 1;
  });

  // Calculate average and target
  const vals = Object.values(numbers);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const target = avg * 0.8;

  // Penalties: start everyone at -1
  const penalties = {};
  active.forEach(p => { penalties[p.id] = 1; });

  let winner = null;
  let exactMatch = false;

  // ── Special case: 2 players + Rule C ──────────────────────────────────
  if (active.length === 2 && rules.ruleC) {
    const [p0, p1] = active;
    const n0 = numbers[p0.id];
    const n1 = numbers[p1.id];

    if ((n0 === 0 && n1 === 100) || (n0 === 100 && n1 === 0)) {
      // 100 beats 0
      winner = (n0 === 100) ? p0 : p1;
      penalties[winner.id] = 0;
      gs.log.push(`⚡ Rule C: 100 overrules 0 → ${winner.name} wins!`);
    } else {
      // Normal resolution (with Rule A, B still active)
      winner = findWinner(active, numbers, target, rules, countMap, penalties, gs);
    }
  } else {
    winner = findWinner(active, numbers, target, rules, countMap, penalties, gs);
  }

  // ── Rule B: exact match → others lose 2 ────────────────────────────────
  if (winner && rules.ruleB) {
    const winNum = numbers[winner.id];
    const dist = Math.abs(winNum - target);
    if (dist < 0.0001) {
      exactMatch = true;
      active.forEach(p => {
        if (p.id !== winner.id) penalties[p.id] = 2;
      });
      gs.log.push(`★ EXACT MATCH by ${winner.name}! Others lose 2 pts.`);
    }
  }

  // ── Apply penalties ────────────────────────────────────────────────────
  active.forEach(p => {
    const pen = penalties[p.id] || 0;
    p.score -= pen;
    gs.players[p.id] = p;
  });

  // ── Check eliminations ─────────────────────────────────────────────────
  const newlyEliminated = active.filter(p => p.score <= -10);
  let newElimCount = 0;

  newlyEliminated.forEach(p => {
    p.eliminated = true;
    gs.players[p.id] = p;
    newElimCount++;
    gs.log.push(`💀 ${p.name} reaches -10. AQUA REGIA.`);
  });

  const prevElim = gs.eliminations;
  gs.eliminations += newElimCount;

  // Mark if next round should have extended timer (new rule unlocked)
  gs._isFirstRoundAfterNewRule = (gs.eliminations !== prevElim);

  gs.log.push(`Round ${gs.round}: avg=${avg.toFixed(2)}, target=${target.toFixed(2)}, winner=${winner ? winner.name : 'none'}`);

  gs.roundResult = {
    round: gs.round,
    numbers,
    avg,
    target,
    winner: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    penalties,
    eliminated: newlyEliminated.map(p => p.id),
    exactMatch,
    activeRules: getActiveRules(gs.eliminations)
  };

  return gs.roundResult;
}

function findWinner(active, numbers, target, rules, countMap, penalties, gs) {
  let winner = null;
  let bestDist = Infinity;

  active.forEach(p => {
    const n = numbers[p.id];

    // Rule A: duplicate → invalid
    if (rules.ruleA && countMap[n] >= 2) {
      // Already penalized, skip
      return;
    }

    const dist = Math.abs(n - target);
    if (dist < bestDist) {
      bestDist = dist;
      winner = p;
    }
  });

  if (winner) {
    penalties[winner.id] = 0;
  } else {
    // All numbers were duplicates (Rule A), no winner this round
    gs.log.push(`⚠️ Round ${gs.round}: All numbers invalid (duplicates). No winner.`);
  }

  return winner;
}

// ─── AI logic ─────────────────────────────────────────────────────────────
function computeAINumber(gs, aiPlayer) {
  const active = Object.values(gs.players).filter(p => !p.eliminated);
  const n = active.length;
  const elim = gs.eliminations;

  // Round 1 strategy: converging on 0 (iterated elimination of dominated strategies)
  if (elim === 0) {
    // AI uses slightly randomized "depth-of-thinking" strategy
    const depth = Math.floor(Math.random() * 4) + 2;
    let val = 50 * Math.pow(0.8, depth);
    val = Math.max(0, Math.min(100, Math.round(val + (Math.random() - 0.5) * 8)));
    return val;
  }

  // After Rule A: battle of 0, 1, 2
  if (elim === 1) {
    const choices = [0, 1, 2];
    return choices[Math.floor(Math.random() * choices.length)];
  }

  // After Rule B: still 0/1/2 territory but more risky
  if (elim === 2) {
    if (n === 2) {
      // Only 2 left: 0 vs 100 becomes key
      return Math.random() < 0.5 ? 0 : 100;
    }
    const r = Math.random();
    if (r < 0.4) return 0;
    if (r < 0.7) return 1;
    return 2;
  }

  // After Rule C (2 players): rock-paper-scissors logic
  if (elim >= 3 && n === 2) {
    const scores = active.map(p => p.score).sort((a, b) => a - b);
    const myScore = aiPlayer.score;
    const isWinning = myScore === Math.max(...active.map(p => p.score));

    if (isWinning) {
      // Leading: choose 0 or 1 (safe play)
      return Math.random() < 0.6 ? 0 : 1;
    } else {
      // Behind: choose 100 to counter 0
      return Math.random() < 0.7 ? 100 : 0;
    }
  }

  return Math.floor(Math.random() * 3); // fallback: 0/1/2
}

// ─── Timer management ─────────────────────────────────────────────────────
function clearRoundTimer(gs) {
  if (gs.timerTimeout) {
    clearTimeout(gs.timerTimeout);
    gs.timerTimeout = null;
  }
}

function startRoundTimer(gs) {
  clearRoundTimer(gs);
  const limit = getRoundTimeLimit(gs);
  gs.roundTimerEnd = Date.now() + limit * 1000;

  // Broadcast timer start
  io.to(gs.code).emit('timer_start', {
    seconds: limit,
    endsAt: gs.roundTimerEnd
  });

  gs.timerTimeout = setTimeout(() => {
    autoSubmitMissing(gs);
  }, limit * 1000);
}

function autoSubmitMissing(gs) {
  const active = Object.values(gs.players).filter(p => !p.eliminated);
  active.forEach(p => {
    if (gs.submissions[p.id] === undefined) {
      const num = p.isAI ? computeAINumber(gs, p) : Math.floor(Math.random() * 101);
      gs.submissions[p.id] = num;
      io.to(gs.code).emit('player_submitted', { playerId: p.id });
    }
  });
  doResolveRound(gs);
}

function doResolveRound(gs) {
  clearRoundTimer(gs);
  const result = resolveRound(gs);

  // Check game over
  const surviving = Object.values(gs.players).filter(p => !p.eliminated);

  if (surviving.length <= 1) {
    gs.phase = 'finished';
    io.to(gs.code).emit('game_over', {
      players: gs.players,
      roundResult: result,
      log: gs.log,
      winner: surviving[0] || null
    });
    return;
  }

  gs.phase = 'round_result';
  io.to(gs.code).emit('round_result', {
    roundResult: result,
    players: gs.players,
    log: gs.log
  });
}

// ─── Socket.IO handlers ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // ── CREATE GAME ──────────────────────────────────────────────────────────
  socket.on('create_game', ({ name }) => {
    const playerId = genId();
    const gs = createGame(playerId, name);
    gs.players[playerId].socketId = socket.id;
    games[gs.code] = gs;

    socket.join(gs.code);
    socket.emit('game_created', {
      code: gs.code,
      playerId,
      players: gs.players
    });
  });

  // ── JOIN GAME ────────────────────────────────────────────────────────────
  socket.on('join_game', ({ code, name }) => {
    const gs = games[code];
    if (!gs) { socket.emit('error', { msg: 'Game not found. Check the code.' }); return; }
    if (gs.phase !== 'waiting') { socket.emit('error', { msg: 'Game already in progress.' }); return; }
    if (Object.keys(gs.players).length >= 5) { socket.emit('error', { msg: 'Room is full (max 5 players).' }); return; }

    const playerId = genId();
    gs.players[playerId] = {
      id: playerId,
      name,
      score: 0,
      eliminated: false,
      isHost: false,
      isAI: false,
      socketId: socket.id
    };

    socket.join(code);
    socket.emit('game_joined', { code, playerId, players: gs.players });
    io.to(code).emit('lobby_update', { players: gs.players });
  });

  // ── START GAME ───────────────────────────────────────────────────────────
  socket.on('start_game', ({ code, playerId, aiCount }) => {
    const gs = games[code];
    if (!gs) return;
    if (gs.players[playerId]?.isHost !== true) { socket.emit('error', { msg: 'Only the host can start.' }); return; }

    const humanCount = Object.keys(gs.players).length;
    const totalAllowed = 5;
    const aiToAdd = Math.min(aiCount || 0, totalAllowed - humanCount);

    const aiNames = ['Chishiya', 'Daimon', 'Kuzuryu', 'Asuma', 'Yashige'];
    for (let i = 0; i < aiToAdd; i++) {
      const aiId = 'ai_' + i;
      gs.players[aiId] = {
        id: aiId,
        name: aiNames[i],
        score: 0,
        eliminated: false,
        isHost: false,
        isAI: true,
        socketId: null
      };
    }

    gs.phase = 'playing';
    gs.round = 1;
    gs.eliminations = 0;
    gs.submissions = {};
    gs._isFirstRoundAfterNewRule = false;
    gs.log = [`♦ King of Diamonds begins. ${Object.keys(gs.players).length} players enter.`];

    io.to(code).emit('game_started', {
      players: gs.players,
      round: gs.round,
      eliminations: gs.eliminations,
      activeRules: getActiveRules(0)
    });

    // Submit AI numbers after short delay
    setTimeout(() => submitAIForRound(gs), 1500 + Math.random() * 1500);
    startRoundTimer(gs);
  });

  // ── SUBMIT NUMBER ────────────────────────────────────────────────────────
  socket.on('submit_number', ({ code, playerId, number }) => {
    const gs = games[code];
    if (!gs) return;
    if (gs.phase !== 'playing') return;
    if (gs.players[playerId]?.eliminated) return;
    if (gs.submissions[playerId] !== undefined) return;
    if (typeof number !== 'number' || number < 0 || number > 100) return;

    gs.submissions[playerId] = Math.round(number);
    io.to(code).emit('player_submitted', { playerId });

    // Check if all active players submitted
    const active = Object.values(gs.players).filter(p => !p.eliminated && !p.isAI);
    const allHumansSubmitted = active.every(p => gs.submissions[p.id] !== undefined);
    const allActive = Object.values(gs.players).filter(p => !p.eliminated);
    const allSubmitted = allActive.every(p => gs.submissions[p.id] !== undefined);

    if (allSubmitted) {
      doResolveRound(gs);
    }
  });

  // ── CONTINUE TO NEXT ROUND ───────────────────────────────────────────────
  socket.on('next_round', ({ code, playerId }) => {
    const gs = games[code];
    if (!gs) return;
    if (!gs.players[playerId]?.isHost) return;
    if (gs.phase !== 'round_result') return;

    gs.round++;
    gs.submissions = {};
    gs.phase = 'playing';

    io.to(code).emit('round_started', {
      round: gs.round,
      players: gs.players,
      eliminations: gs.eliminations,
      activeRules: getActiveRules(gs.eliminations),
      isFirstRoundAfterNewRule: gs._isFirstRoundAfterNewRule || false
    });

    gs._isFirstRoundAfterNewRule = false;

    setTimeout(() => submitAIForRound(gs), 1500 + Math.random() * 2000);
    startRoundTimer(gs);
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Find any game this socket was in and mark player disconnected
    Object.values(games).forEach(gs => {
      const player = Object.values(gs.players).find(p => p.socketId === socket.id);
      if (player && gs.phase === 'waiting') {
        delete gs.players[player.id];
        io.to(gs.code).emit('lobby_update', { players: gs.players });
      }
    });
  });
});

// ─── AI submission helper ──────────────────────────────────────────────────
function submitAIForRound(gs) {
  if (gs.phase !== 'playing') return;
  Object.values(gs.players).forEach(p => {
    if (!p.isAI || p.eliminated) return;
    if (gs.submissions[p.id] !== undefined) return;
    gs.submissions[p.id] = computeAINumber(gs, p);
    io.to(gs.code).emit('player_submitted', { playerId: p.id });
  });

  // Check if all submitted now
  const allActive = Object.values(gs.players).filter(p => !p.eliminated);
  if (allActive.every(p => gs.submissions[p.id] !== undefined)) {
    doResolveRound(gs);
  }
}

// ─── Start server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`♦ King of Diamonds server running on port ${PORT}`);
});
