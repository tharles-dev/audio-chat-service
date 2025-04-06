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
const mutedUsers = new Map();
const userSockets = new Map(); // Novo: mapear userId para socket
const speakingUsers = new Map(); // roomId -> Set of speaking userIds

// Função para validar entrada na sala
function validateRoomEntry(gameId, userId, username) {
  // Validar parâmetros
  if (!gameId || !userId || !username) {
    return { valid: false, error: 'Parâmetros inválidos' };
  }

  // Validar formato do userId (deve ser um UUID válido)
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return { valid: false, error: 'ID de usuário inválido' };
  }

  // Verificar se o usuário já está em alguma sala
  if (userSockets.has(userId)) {
    const userSocket = userSockets.get(userId);
    const userRooms = Array.from(userSocket.rooms);
    const currentRoom = userRooms.find((room) => room !== userSocket.id);

    // Se o usuário já está na sala que está tentando entrar, não permitir
    if (currentRoom === gameId) {
      return { valid: false, error: 'Usuário já está nesta sala' };
    }

    // Se o usuário está em outra sala, remover da sala anterior
    if (currentRoom) {
      console.log(
        `[${new Date().toISOString()}] Removendo usuário ${userId} da sala ${currentRoom} antes de entrar na nova sala`
      );
      if (rooms.has(currentRoom)) {
        rooms.get(currentRoom).delete(userId);
        if (rooms.get(currentRoom).size === 0) {
          checkEmptyRoom(currentRoom);
        }
      }
      userSocket.leave(currentRoom);
    }
  }

  // Verificar se a sala está cheia
  if (rooms.has(gameId) && rooms.get(gameId).size >= MAX_USERS_PER_ROOM) {
    return { valid: false, error: 'Sala cheia' };
  }

  return { valid: true };
}

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

    // Log para depuração
    console.log(
      `[${new Date().toISOString()}] Estado atual: userSockets tem ${userId}? ${userSockets.has(
        userId
      )}`
    );
    if (userSockets.has(userId)) {
      const userSocket = userSockets.get(userId);
      console.log(
        `[${new Date().toISOString()}] Usuário está em ${
          userSocket.rooms.size
        } salas`
      );
    }

    // Validar entrada
    const validation = validateRoomEntry(gameId, userId, username);
    if (!validation.valid) {
      console.log(
        `[${new Date().toISOString()}] Entrada negada: ${validation.error}`
      );
      socket.emit('error', validation.error);
      return;
    }

    // Registrar socket do usuário
    userSockets.set(userId, socket);

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
      `[${new Date().toISOString()}] Usuário ${userId} saiu da sala ${gameId}`
    );

    // Limpar estado de mute
    if (mutedUsers.has(userId)) {
      mutedUsers.delete(userId);
    }

    // Remover usuário da sala
    if (rooms.has(gameId)) {
      rooms.get(gameId).delete(userId);
      if (rooms.get(gameId).size === 0) {
        checkEmptyRoom(gameId);
      }
    }

    // Limpar mapeamentos
    socketToUserId.delete(socket.id);
    userNames.delete(userId);

    // Remover o socket do usuário do mapeamento userSockets
    if (userSockets.has(userId)) {
      userSockets.delete(userId);
    }

    // Notificar outros usuários
    io.to(gameId).emit('user-left', { userId });
  });

  // Quando um usuário desconectar
  socket.on('disconnect', () => {
    const currentUserId = socketToUserId.get(socket.id);
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );

    if (currentUserId && currentRoom) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${currentUserId} desconectou da sala ${currentRoom}`
      );

      // Limpar estado de mute
      if (mutedUsers.has(currentUserId)) {
        mutedUsers.delete(currentUserId);
      }

      // Remover usuário da sala
      if (rooms.has(currentRoom)) {
        rooms.get(currentRoom).delete(currentUserId);
        if (rooms.get(currentRoom).size === 0) {
          checkEmptyRoom(currentRoom);
        }
      }

      // Limpar mapeamentos
      socketToUserId.delete(socket.id);
      userNames.delete(currentUserId);

      // Remover o socket do usuário do mapeamento userSockets
      if (userSockets.has(currentUserId)) {
        userSockets.delete(currentUserId);
      }

      // Notificar outros usuários
      io.to(currentRoom).emit('user-disconnected', { userId: currentUserId });
    }
  });

  // Quando receber uma oferta de conexão
  socket.on('offer', (offer, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Oferta de ${currentUserId} para ${targetUserId}`
    );

    // Verificar se o usuário alvo ainda está na sala
    const targetSocket = getUserSocket(targetUserId);
    if (!targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId} - ignorando oferta`
      );
      return;
    }

    // Verificar se o usuário alvo está na mesma sala
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );
    const targetRooms = Array.from(targetSocket.rooms);
    const targetRoom = targetRooms.find((room) => room !== targetSocket.id);

    if (currentRoom !== targetRoom) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${targetUserId} não está na mesma sala - ignorando oferta`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Enviando oferta para socket ${
        targetSocket.id
      }`
    );
    targetSocket.emit('offer', { offer, fromUserId: currentUserId });
  });

  // Quando receber uma resposta
  socket.on('answer', (answer, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Resposta de ${currentUserId} para ${targetUserId}`
    );

    // Verificar se o usuário alvo ainda está na sala
    const targetSocket = getUserSocket(targetUserId);
    if (!targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId} - ignorando resposta`
      );
      return;
    }

    // Verificar se o usuário alvo está na mesma sala
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );
    const targetRooms = Array.from(targetSocket.rooms);
    const targetRoom = targetRooms.find((room) => room !== targetSocket.id);

    if (currentRoom !== targetRoom) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${targetUserId} não está na mesma sala - ignorando resposta`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Enviando resposta para socket ${
        targetSocket.id
      }`
    );
    targetSocket.emit('answer', { answer, fromUserId: currentUserId });
  });

  // Quando receber um candidato ICE
  socket.on('ice-candidate', (candidate, targetUserId) => {
    console.log(
      `[${new Date().toISOString()}] Candidato ICE de ${currentUserId} para ${targetUserId}`
    );

    // Verificar se o usuário alvo ainda está na sala
    const targetSocket = getUserSocket(targetUserId);
    if (!targetSocket) {
      console.log(
        `[${new Date().toISOString()}] Socket não encontrado para o usuário ${targetUserId} - ignorando candidato ICE`
      );
      return;
    }

    // Verificar se o usuário alvo está na mesma sala
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );
    const targetRooms = Array.from(targetSocket.rooms);
    const targetRoom = targetRooms.find((room) => room !== targetSocket.id);

    if (currentRoom !== targetRoom) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${targetUserId} não está na mesma sala - ignorando candidato ICE`
      );
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Enviando candidato ICE para socket ${
        targetSocket.id
      }`
    );
    targetSocket.emit('ice-candidate', {
      candidate,
      fromUserId: currentUserId,
    });
  });

  // Novo evento para mutar/desmutar um participante específico
  socket.on('toggle-participant-mute', ({ targetUserId, isMuted }) => {
    const currentUserId = socketToUserId.get(socket.id);
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );

    if (!currentRoom || !currentUserId) {
      console.log(
        `[${new Date().toISOString()}] Tentativa de mutar falhou: usuário não está em uma sala`
      );
      return;
    }

    // Verificar se o usuário que está enviando o evento é o dono da sala
    const roomOwner = rooms.get(currentRoom)?.owner;
    if (roomOwner && roomOwner !== currentUserId) {
      console.log(
        `[${new Date().toISOString()}] Tentativa de mutar falhou: usuário ${currentUserId} não é o dono da sala`
      );
      socket.emit('error', 'Apenas o dono da sala pode mutar participantes');
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Usuário ${currentUserId} ${
        isMuted ? 'mutando' : 'desmutando'
      } ${targetUserId}`
    );

    if (!mutedUsers.has(targetUserId)) {
      mutedUsers.set(targetUserId, new Set());
    }

    if (isMuted) {
      mutedUsers.get(targetUserId).add(currentUserId);
    } else {
      mutedUsers.get(targetUserId).delete(currentUserId);
    }

    const totalUsuariosNaSala = rooms.get(currentRoom).size;

    // Notificar todos os usuários na sala
    io.to(currentRoom).emit('participant-mute-changed', {
      userId: targetUserId,
      isMuted,
      mutedBy: currentUserId,
      sala: currentRoom,
      totalUsuariosNaSala,
    });

    // Enviar evento force-mute usando io.to
    io.to(targetUserId).emit('force-mute', { isMuted });

    console.log(
      `[${new Date().toISOString()}] [${currentRoom}] Enviando evento force-mute para usuário ${targetUserId}: { isMuted: ${isMuted} }`
    );
  });

  // Novo evento para atualizar status de fala
  socket.on('speaking-status', ({ userId, isSpeaking }) => {
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );
    if (!currentRoom) return;

    if (!speakingUsers.has(currentRoom)) {
      speakingUsers.set(currentRoom, new Set());
    }

    if (isSpeaking) {
      speakingUsers.get(currentRoom).add(userId);
    } else {
      speakingUsers.get(currentRoom).delete(userId);
    }

    // Notificar todos os usuários na sala sobre a mudança
    io.to(currentRoom).emit('speaking-status-update', {
      userId,
      isSpeaking,
    });
  });

  // Novo evento para diagnóstico de conexões
  socket.on('check-connection', () => {
    const currentUserId = socketToUserId.get(socket.id);
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );

    console.log(
      `[${new Date().toISOString()}] Verificação de conexão solicitada por ${
        currentUserId || 'socket desconhecido'
      }`
    );

    // Verificar se o usuário está registrado
    if (currentUserId) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${currentUserId} está registrado`
      );

      // Verificar se o usuário está em uma sala
      if (currentRoom) {
        console.log(
          `[${new Date().toISOString()}] Usuário ${currentUserId} está na sala ${currentRoom}`
        );

        // Verificar se o usuário está no mapeamento userSockets
        if (userSockets.has(currentUserId)) {
          console.log(
            `[${new Date().toISOString()}] Usuário ${currentUserId} está no mapeamento userSockets`
          );

          // Verificar se o socket está conectado
          if (socket.connected) {
            console.log(
              `[${new Date().toISOString()}] Socket do usuário ${currentUserId} está conectado`
            );

            // Enviar resposta com informações detalhadas
            socket.emit('connection-status', {
              userId: currentUserId,
              room: currentRoom,
              connected: true,
              inUserSockets: true,
              socketId: socket.id,
              rooms: Array.from(socket.rooms),
              usersInRoom: rooms.has(currentRoom)
                ? Array.from(rooms.get(currentRoom))
                : [],
            });
          } else {
            console.log(
              `[${new Date().toISOString()}] Socket do usuário ${currentUserId} não está conectado`
            );
            socket.emit('connection-status', {
              userId: currentUserId,
              room: currentRoom,
              connected: false,
              inUserSockets: true,
              socketId: socket.id,
              rooms: Array.from(socket.rooms),
              usersInRoom: rooms.has(currentRoom)
                ? Array.from(rooms.get(currentRoom))
                : [],
            });
          }
        } else {
          console.log(
            `[${new Date().toISOString()}] Usuário ${currentUserId} não está no mapeamento userSockets`
          );
          socket.emit('connection-status', {
            userId: currentUserId,
            room: currentRoom,
            connected: socket.connected,
            inUserSockets: false,
            socketId: socket.id,
            rooms: Array.from(socket.rooms),
            usersInRoom: rooms.has(currentRoom)
              ? Array.from(rooms.get(currentRoom))
              : [],
          });
        }
      } else {
        console.log(
          `[${new Date().toISOString()}] Usuário ${currentUserId} não está em nenhuma sala`
        );
        socket.emit('connection-status', {
          userId: currentUserId,
          room: null,
          connected: socket.connected,
          inUserSockets: userSockets.has(currentUserId),
          socketId: socket.id,
          rooms: Array.from(socket.rooms),
        });
      }
    } else {
      console.log(
        `[${new Date().toISOString()}] Socket ${
          socket.id
        } não está associado a nenhum usuário`
      );
      socket.emit('connection-status', {
        userId: null,
        room: null,
        connected: socket.connected,
        inUserSockets: false,
        socketId: socket.id,
        rooms: Array.from(socket.rooms),
      });
    }
  });

  // Novo evento para verificar o estado do mute de um usuário
  socket.on('check-mute-status', ({ targetUserId }) => {
    const currentUserId = socketToUserId.get(socket.id);
    const currentRoom = Array.from(socket.rooms).find(
      (room) => room !== socket.id
    );

    console.log(
      `[${new Date().toISOString()}] Verificação de mute solicitada por ${currentUserId} para ${targetUserId}`
    );

    if (!currentRoom || !currentUserId) {
      console.log(
        `[${new Date().toISOString()}] Verificação de mute falhou: usuário não está em uma sala`
      );
      socket.emit('mute-status', {
        targetUserId,
        isMuted: false,
        mutedBy: [],
        error: 'Usuário não está em uma sala',
      });
      return;
    }

    // Verificar se o usuário alvo está na sala
    if (!rooms.has(currentRoom) || !rooms.get(currentRoom).has(targetUserId)) {
      console.log(
        `[${new Date().toISOString()}] Usuário ${targetUserId} não está na sala ${currentRoom}`
      );
      socket.emit('mute-status', {
        targetUserId,
        isMuted: false,
        mutedBy: [],
        error: 'Usuário alvo não está na sala',
      });
      return;
    }

    // Verificar o estado do mute
    const isMuted =
      mutedUsers.has(targetUserId) && mutedUsers.get(targetUserId).size > 0;
    const mutedBy = isMuted ? Array.from(mutedUsers.get(targetUserId)) : [];

    console.log(
      `[${new Date().toISOString()}] Estado do mute para ${targetUserId}: ${
        isMuted ? 'mutado' : 'não mutado'
      }`
    );
    if (isMuted) {
      console.log(
        `[${new Date().toISOString()}] Mutado por: ${mutedBy.join(', ')}`
      );
    }

    // Enviar resposta
    socket.emit('mute-status', {
      targetUserId,
      isMuted,
      mutedBy,
      room: currentRoom,
    });

    // Se o usuário alvo for o próprio usuário, enviar o estado atual do mute
    if (targetUserId === currentUserId) {
      console.log(
        `[${new Date().toISOString()}] Enviando estado atual do mute para o próprio usuário`
      );
      socket.emit('force-mute', { isMuted });
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

// Atualizar a função de limpeza de sala para incluir speakingUsers
function cleanupRoom(roomId) {
  if (rooms.has(roomId)) {
    rooms.delete(roomId);
  }
  if (speakingUsers.has(roomId)) {
    speakingUsers.delete(roomId);
  }
}

server.listen(PORT, () => {
  console.log(
    `[${new Date().toISOString()}] Servidor rodando na porta ${PORT}`
  );
  console.log(
    `[${new Date().toISOString()}] Acesse http://localhost:${PORT} para começar`
  );
});
