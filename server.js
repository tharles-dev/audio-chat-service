const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Configurações
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_USERS_PER_ROOM || '10', 10);
const ROOM_TIMEOUT = parseInt(process.env.ROOM_TIMEOUT || '1800000', 10); // 30 minutos por padrão

console.log(`Iniciando servidor em modo ${NODE_ENV}`);
console.log(`Porta: ${PORT}`);
console.log(`Origens CORS permitidas: ${CORS_ORIGIN.join(', ')}`);
console.log(`Máximo de usuários por sala: ${MAX_USERS_PER_ROOM}`);
console.log(`Timeout de sala: ${ROOM_TIMEOUT / 60000} minutos`);

const app = express();
app.use(cors());

// Servir arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Armazenar as conexões ativas
const rooms = new Map();
const roomTimeouts = new Map();
const userNames = new Map();
const socketToUserId = new Map();

// Função para verificar se uma sala está vazia e removê-la após um tempo
function checkEmptyRoom(roomId) {
  if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
    // Agendar remoção da sala após o timeout
    const timeoutId = setTimeout(() => {
      if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
        console.log(
          `[${new Date().toISOString()}] Removendo sala vazia: ${roomId}`
        );
        rooms.delete(roomId);
        roomTimeouts.delete(roomId);
      }
    }, ROOM_TIMEOUT);

    roomTimeouts.set(roomId, timeoutId);
  }
}

// Função para cancelar o timeout de remoção da sala
function cancelRoomTimeout(roomId) {
  if (roomTimeouts.has(roomId)) {
    clearTimeout(roomTimeouts.get(roomId));
    roomTimeouts.delete(roomId);
  }
}

// Função para obter o socket de um usuário
function getUserSocket(userId) {
  for (const [socketId, id] of socketToUserId.entries()) {
    if (id === userId) {
      return io.sockets.sockets.get(socketId);
    }
  }
  return null;
}

// Função para logar estatísticas
function logStats() {
  const activeRooms = Array.from(rooms.keys());
  const totalUsers = Array.from(rooms.values()).reduce(
    (sum, users) => sum + users.size,
    0
  );

  console.log(`[${new Date().toISOString()}] Estatísticas:`);
  console.log(`- Salas ativas: ${activeRooms.length}`);
  console.log(`- Total de usuários: ${totalUsers}`);
  console.log(`- Uptime: ${Math.floor(process.uptime() / 60)} minutos`);

  // Log detalhado de cada sala
  activeRooms.forEach((roomId) => {
    const users = Array.from(rooms.get(roomId));
    console.log(`- Sala ${roomId}: ${users.length} usuários`);
  });
}

// Logar estatísticas a cada 5 minutos
setInterval(logStats, 5 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Usuário conectado: ${socket.id}`);
  let currentRoom = null;
  let currentUserId = null;

  // Quando um usuário quer criar ou entrar em uma sala
  socket.on('join', ({ gameId, userId, username }) => {
    console.log(
      `[${new Date().toISOString()}] Usuário ${username} (${userId}) tentando entrar na sala ${gameId}`
    );

    // Verificar se a sala existe e está cheia
    if (rooms.has(gameId) && rooms.get(gameId).size >= MAX_USERS_PER_ROOM) {
      console.log(
        `[${new Date().toISOString()}] Tentativa de entrar em sala cheia: ${gameId}`
      );
      socket.emit('error', 'Sala cheia');
      return;
    }

    // Se o usuário já está em uma sala, remova-o
    if (currentRoom) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${currentUserId} saindo da sala ${currentRoom} para entrar em ${gameId}`
      );
      socket.leave(currentRoom);
      if (rooms.has(currentRoom)) {
        rooms.get(currentRoom).delete(currentUserId);
        checkEmptyRoom(currentRoom);
      }
    }

    // Entrar na nova sala
    socket.join(gameId);
    currentRoom = gameId;
    currentUserId = userId;
    userNames.set(userId, username);
    socketToUserId.set(socket.id, userId);

    // Cancelar timeout de remoção se existir
    cancelRoomTimeout(gameId);

    // Adicionar usuário à sala
    if (!rooms.has(gameId)) {
      rooms.set(gameId, new Set());
    }
    rooms.get(gameId).add(userId);

    // Notificar outros usuários na sala
    socket.to(gameId).emit('user-connected', { userId, username });

    // Enviar lista de usuários existentes para o novo usuário
    const usersInRoom = Array.from(rooms.get(gameId)).map((id) => ({
      userId: id,
      username: userNames.get(id),
    }));

    // Enviar lista atualizada para todos os usuários na sala
    io.to(gameId).emit('participants', usersInRoom);

    console.log(
      `[${new Date().toISOString()}] Usuário ${username} (${userId}) entrou na sala ${gameId}`
    );
    console.log(
      `[${new Date().toISOString()}] Participantes na sala ${gameId}:`,
      usersInRoom.map((u) => u.username).join(', ')
    );
  });

  // Quando um usuário quer sair da sala
  socket.on('leave', ({ gameId, userId }) => {
    console.log(
      `[${new Date().toISOString()}] Usuário ${userId} saindo da sala ${gameId}`
    );

    if (rooms.has(gameId)) {
      rooms.get(gameId).delete(userId);
      checkEmptyRoom(gameId);
    }
    socket
      .to(gameId)
      .emit('user-disconnected', { userId, username: userNames.get(userId) });
    userNames.delete(userId);
    socketToUserId.delete(socket.id);
    currentRoom = null;
    currentUserId = null;
  });

  // Quando um usuário desconectar
  socket.on('disconnect', () => {
    console.log(
      `[${new Date().toISOString()}] Usuário desconectado: ${socket.id}`
    );

    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(currentUserId);
      checkEmptyRoom(currentRoom);
      socket.to(currentRoom).emit('user-disconnected', {
        userId: currentUserId,
        username: userNames.get(currentUserId),
      });
      userNames.delete(currentUserId);
      socketToUserId.delete(socket.id);
    }
  });

  // Quando receber uma oferta de conexão
  socket.on('offer', (offer, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Oferta de ${currentUserId} para ${targetUserId}`
    );

    const targetSocket = getUserSocket(targetUserId);
    if (targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Enviando oferta para socket ${
          targetSocket.id
        }`
      );
      targetSocket.emit('offer', { offer, fromUserId: currentUserId });
    } else {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId}`
      );
    }
  });

  // Quando receber uma resposta
  socket.on('answer', (answer, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Resposta de ${currentUserId} para ${targetUserId}`
    );

    const targetSocket = getUserSocket(targetUserId);
    if (targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Enviando resposta para socket ${
          targetSocket.id
        }`
      );
      targetSocket.emit('answer', { answer, fromUserId: currentUserId });
    } else {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId}`
      );
    }
  });

  // Quando receber um candidato ICE
  socket.on('ice-candidate', (candidate, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Candidato ICE de ${currentUserId} para ${targetUserId}`
    );

    const targetSocket = getUserSocket(targetUserId);
    if (targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Enviando candidato ICE para socket ${
          targetSocket.id
        }`
      );
      targetSocket.emit('ice-candidate', {
        candidate,
        fromUserId: currentUserId,
      });
    } else {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId}`
      );
    }
  });
});

// Rota para verificar o status do servidor
app.get('/status', (req, res) => {
  const activeRooms = Array.from(rooms.keys());
  const totalUsers = Array.from(rooms.values()).reduce(
    (sum, users) => sum + users.size,
    0
  );

  res.json({
    status: 'online',
    activeRooms: activeRooms.length,
    totalUsers,
    uptime: process.uptime(),
    environment: NODE_ENV,
    version: '1.0.0',
  });
});

// Rota para health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Erro não capturado:`, err);
  // Não encerrar o processo, apenas logar o erro
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(
    `[${new Date().toISOString()}] Promessa rejeitada não tratada:`,
    reason
  );
  // Não encerrar o processo, apenas logar o erro
});

server.listen(PORT, () => {
  console.log(
    `[${new Date().toISOString()}] Servidor rodando na porta ${PORT}`
  );
  console.log(
    `[${new Date().toISOString()}] Acesse http://localhost:${PORT} para começar`
  );
});
