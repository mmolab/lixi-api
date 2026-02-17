const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["https://clawdaily.blog", "http://localhost:3000", "https://lixi-api.onrender.com"],
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data', 'game-state.json');

// Middleware
app.use(cors({
  origin: ["https://clawdaily.blog", "http://localhost:3000", "https://lixi-api.onrender.com"]
}));
app.use(express.json());

// Initialize data directory
async function initializeData() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    
    // Check if data file exists, create default if not
    try {
      await fs.access(DATA_FILE);
    } catch {
      const defaultGameState = {
        sessionId: uuidv4(),
        totalMoney: 500000,
        remainingMoney: 500000,
        remainingEnvelopes: 10,
        maxPlayers: 10,
        players: [],
        openedBy: [],
        isActive: true,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString()
      };
      await fs.writeFile(DATA_FILE, JSON.stringify(defaultGameState, null, 2));
    }
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

// Load game state
async function loadGameState() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading game state:', error);
    return null;
  }
}

// Save game state
async function saveGameState(gameState) {
  try {
    gameState.lastActivity = new Date().toISOString();
    await fs.writeFile(DATA_FILE, JSON.stringify(gameState, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving game state:', error);
    return false;
  }
}

// Calculate fair random amount
function calculateRandomAmount(remainingMoney, remainingEnvelopes) {
  const minAmount = 10000;
  const maxAmount = 100000;
  
  if (remainingEnvelopes === 1) {
    return remainingMoney; // Last envelope gets all remaining money
  }
  
  // Ensure there's enough money left for remaining envelopes
  const minForRemaining = (remainingEnvelopes - 1) * minAmount;
  const availableForThis = remainingMoney - minForRemaining;
  const maxForThis = Math.min(maxAmount, availableForThis);
  
  return Math.max(minAmount, Math.floor(Math.random() * (maxForThis - minAmount + 1)) + minAmount);
}

// API Routes
app.get('/api/game/status', async (req, res) => {
  const gameState = await loadGameState();
  if (!gameState) {
    return res.status(500).json({ error: 'Unable to load game state' });
  }
  
  res.json({
    sessionId: gameState.sessionId,
    totalMoney: gameState.totalMoney,
    remainingMoney: gameState.remainingMoney,
    remainingEnvelopes: gameState.remainingEnvelopes,
    maxPlayers: gameState.maxPlayers,
    currentPlayers: gameState.players.length,
    isActive: gameState.isActive,
    openedBy: gameState.openedBy
  });
});

app.post('/api/game/join', async (req, res) => {
  const { playerName, playerId } = req.body;
  
  if (!playerName || !playerId) {
    return res.status(400).json({ error: 'Player name and ID required' });
  }
  
  const gameState = await loadGameState();
  if (!gameState) {
    return res.status(500).json({ error: 'Unable to load game state' });
  }
  
  // Check if player already joined
  const existingPlayer = gameState.players.find(p => p.id === playerId);
  if (existingPlayer) {
    return res.json({ success: true, message: 'Player already joined' });
  }
  
  // Check if game is full
  if (gameState.players.length >= gameState.maxPlayers) {
    return res.status(400).json({ error: 'Game is full' });
  }
  
  // Check if game is still active
  if (!gameState.isActive) {
    return res.status(400).json({ error: 'Game is not active' });
  }
  
  // Add player
  gameState.players.push({
    id: playerId,
    name: playerName,
    joinedAt: new Date().toISOString()
  });
  
  await saveGameState(gameState);
  
  // Broadcast to all clients
  io.emit('playerJoined', {
    playerId,
    playerName,
    currentPlayers: gameState.players.length
  });
  
  res.json({ success: true, message: 'Player joined successfully' });
});

app.post('/api/game/open', async (req, res) => {
  const { playerId, playerName } = req.body;
  
  if (!playerId) {
    return res.status(400).json({ error: 'Player ID required' });
  }
  
  const gameState = await loadGameState();
  if (!gameState) {
    return res.status(500).json({ error: 'Unable to load game state' });
  }
  
  // Check if game is active
  if (!gameState.isActive || gameState.remainingEnvelopes <= 0) {
    return res.status(400).json({ error: 'Game is not active or no envelopes remaining' });
  }
  
  // Check if player already opened an envelope
  if (gameState.openedBy.some(entry => entry.playerId === playerId)) {
    return res.status(400).json({ error: 'Player already opened an envelope' });
  }
  
  // Calculate random amount
  const amount = calculateRandomAmount(gameState.remainingMoney, gameState.remainingEnvelopes);
  
  // Update game state
  gameState.remainingMoney -= amount;
  gameState.remainingEnvelopes--;
  gameState.openedBy.push({
    playerId,
    playerName,
    amount,
    openedAt: new Date().toISOString()
  });
  
  // Check if game is finished
  if (gameState.remainingEnvelopes <= 0) {
    gameState.isActive = false;
  }
  
  await saveGameState(gameState);
  
  // Broadcast to all clients
  io.emit('envelopeOpened', {
    playerId,
    playerName,
    amount,
    remainingMoney: gameState.remainingMoney,
    remainingEnvelopes: gameState.remainingEnvelopes,
    isGameFinished: !gameState.isActive
  });
  
  res.json({
    success: true,
    amount,
    remainingMoney: gameState.remainingMoney,
    remainingEnvelopes: gameState.remainingEnvelopes,
    isGameFinished: !gameState.isActive
  });
});

// Admin routes
app.post('/api/admin/reset', async (req, res) => {
  const newGameState = {
    sessionId: uuidv4(),
    totalMoney: 500000,
    remainingMoney: 500000,
    remainingEnvelopes: 10,
    maxPlayers: 10,
    players: [],
    openedBy: [],
    isActive: true,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString()
  };
  
  const saved = await saveGameState(newGameState);
  if (!saved) {
    return res.status(500).json({ error: 'Unable to reset game' });
  }
  
  // Broadcast reset to all clients
  io.emit('gameReset', newGameState);
  
  res.json({ 
    success: true, 
    message: 'Game reset successfully',
    sessionId: newGameState.sessionId,
    shareUrl: `https://clawdaily.blog/lixi?session=${newGameState.sessionId}`
  });
});

app.get('/api/admin/stats', async (req, res) => {
  const gameState = await loadGameState();
  if (!gameState) {
    return res.status(500).json({ error: 'Unable to load game state' });
  }
  
  res.json({
    ...gameState,
    shareUrl: `https://clawdaily.blog/lixi?session=${gameState.sessionId}`
  });
});

// Socket.io connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('requestGameStatus', async () => {
    const gameState = await loadGameState();
    if (gameState) {
      socket.emit('gameStatus', {
        totalMoney: gameState.totalMoney,
        remainingMoney: gameState.remainingMoney,
        remainingEnvelopes: gameState.remainingEnvelopes,
        currentPlayers: gameState.players.length,
        maxPlayers: gameState.maxPlayers,
        isActive: gameState.isActive,
        openedBy: gameState.openedBy
      });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Initialize and start server
initializeData().then(() => {
  server.listen(PORT, () => {
    console.log(`🧧 Lì Xì API Server running on port ${PORT}`);
    console.log(`🔗 Admin panel: http://localhost:${PORT}/admin`);
  });
});