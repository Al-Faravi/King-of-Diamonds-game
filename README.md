# ♦ King of Diamonds — Multiplayer Game

A real-time multiplayer implementation of the King of Diamonds game from Alice in Borderland.

## Project Structure

```
king-of-diamonds/
├── server.js          ← Node.js + Socket.IO backend (all game logic)
├── public/
│   └── index.html     ← Frontend (HTML/CSS/JS)
├── package.json
└── render.yaml        ← Render deployment config
```

## Local Testing

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Render (Free)

1. Push this folder to a **GitHub repository**
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Render will auto-detect `render.yaml` — click **Apply**
5. Wait ~2 min for deploy
6. Share the URL with friends!

## Game Rules Implemented

### Basic (all rounds)
- Choose 0–100
- Target = avg × 0.8
- Closest wins (no penalty), others –1
- Score –10 → eliminated with aqua regia

### Rule A (after 1st elimination)
- If 2+ players pick the same number → **invalid**, all lose 1 pt
- 5-minute timer for the round this unlocks

### Rule B (after 2nd elimination)
- If winner's number exactly equals target → **all others lose 2 pts** instead of 1
- 5-minute timer for the round this unlocks

### Rule C (after 3rd elimination / 2 players left)
- If one player picks 0 and the other picks 100 → **100 wins**
- Becomes rock-paper-scissors: 0 beats 1, 1 beats 100, 100 beats 0
- 5-minute timer for the round this unlocks

### Timer
- Round 1: **5 minutes**
- Every round after a new rule unlocks: **5 minutes**
- Normal rounds: **1 minute**
- Auto-submits random number if timer expires

## AI Players
- Named after Alice in Borderland characters (Chishiya, Daimon, etc.)
- Strategy adapts based on which rules are active
- Host can add 0–4 AI players before starting
