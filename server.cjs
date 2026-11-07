
const { createServer } = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {};
const HISTORY_FILE = path.join(__dirname, 'question-history.json');

let questionHistory = {};

try {
  if (fs.existsSync(HISTORY_FILE)) {
    questionHistory = JSON.parse(
      fs.readFileSync(HISTORY_FILE, 'utf8')
    );
  }
} catch (error) {
  console.error('Ошибка загрузки истории вопросов:', error);
  questionHistory = {};
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(questionHistory, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Ошибка сохранения истории:', error);
  }
}

function saveRoomHistory(room) {
  questionHistory[room.code] = {
    usedQuestions: room.usedQuestions,
    previousGameQuestions: room.previousGameQuestions,
    usedCells: room.usedCells
  };

  saveHistory();
}

function clearQuestionTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
}

function sendRoom(code) {
  const room = rooms[code];
  if (!room) return;

  room.players.forEach(player => {
    let activeQuestion = null;

    if (room.activeQuestion) {
      const { answer, ...publicQuestion } = room.activeQuestion;

      activeQuestion = player.id === room.hostId
        ? { ...publicQuestion, answer }
        : publicQuestion;
    }

    io.to(player.id).emit('room-updated', {
      code: room.code,
      players: room.players,
      hostId: room.hostId,
      categories: room.categories,
      activeQuestion,
      usedQuestions: room.usedQuestions,
      previousGameQuestions: room.previousGameQuestions,
      usedCells: room.usedCells,
      timerSeconds: room.timerSeconds
    });
  });
}

function generateRoomCode() {
  let code;

  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[code]);

  return code;
}

function isHost(socket, room) {
  return room && room.hostId === socket.id;
}

io.on('connection', socket => {
  console.log('Подключился:', socket.id);

  // Создание комнаты
  socket.on('create-room', (name, callback) => {
    const code = generateRoomCode();
    const savedHistory = questionHistory[code] || {};

    const room = {
      code,
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name,
          score: 0
        }
      ],
      categories: [],
      activeQuestion: null,
      usedQuestions: savedHistory.usedQuestions || [],
      previousGameQuestions: savedHistory.previousGameQuestions || [],
      usedCells: savedHistory.usedCells || [],
      timerSeconds: 60,
      timerHandle: null
    };

    rooms[code] = room;
    socket.join(code);

    sendRoom(code);

    if (callback) {
      callback({ success: true, code });
    }
  });

  // Подключение к комнате
  socket.on('join-room', ({ code, name }, callback) => {
    const room = rooms[code];

    if (!room) {
      if (callback) {
        callback({
          success: false,
          error: 'Комната не найдена'
        });
      }
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      score: 0
    });

    socket.join(code);
    sendRoom(code);

    if (callback) {
      callback({ success: true, code });
    }
  });

  // Выбор категорий
  socket.on('set-categories', ({ code, categories }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может выбирать категории'
        });
      }
      return;
    }

    room.categories = categories;
    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Настройка таймера
  socket.on('set-timer', ({ code, seconds }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может менять таймер'
        });
      }
      return;
    }

    room.timerSeconds = seconds;
    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Открытие вопроса
  socket.on('open-question', (
    { code, category, points, question, answer },
    callback
  ) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может открывать вопросы'
        });
      }
      return;
    }

    if (room.activeQuestion) {
      if (callback) {
        callback({
          success: false,
          error: 'Сначала закройте текущий вопрос'
        });
      }
      return;
    }

    const cellId = `${category}|${points}`;

    if (room.usedCells.includes(cellId)) {
      if (callback) {
        callback({
          success: false,
          error: 'Этот вопрос уже использован'
        });
      }
      return;
    }

    clearQuestionTimer(room);

    room.usedCells.push(cellId);

    if (!room.usedQuestions.includes(question)) {
      room.usedQuestions.push(question);
    }

    room.activeQuestion = {
      category,
      points,
      question,
      answer,
      revealed: false,
      deadlineAt: room.timerSeconds
        ? Date.now() + room.timerSeconds * 1000
        : null,
      expired: false
    };

    saveRoomHistory(room);

    if (room.timerSeconds) {
      room.timerHandle = setTimeout(() => {
        if (!rooms[code] || !room.activeQuestion) return;

        room.activeQuestion.expired = true;
        room.timerHandle = null;

        sendRoom(code);
      }, room.timerSeconds * 1000);
    }

    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Старое событие для совместимости
  socket.on('reveal-answer', ({ code }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room) || !room.activeQuestion) {
      if (callback) {
        callback({
          success: false,
          error: 'Невозможно показать ответ'
        });
      }
      return;
    }

    room.activeQuestion.revealed = true;
    clearQuestionTimer(room);

    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Начисление очков без показа ответа
  socket.on('award-points', ({ code, playerId }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может начислять очки'
        });
      }
      return;
    }

    if (!room.activeQuestion) {
      if (callback) {
        callback({
          success: false,
          error: 'Нет открытого вопроса'
        });
      }
      return;
    }

    const player = room.players.find(
      player => player.id === playerId
    );

    if (!player) {
      if (callback) {
        callback({
          success: false,
          error: 'Игрок не найден'
        });
      }
      return;
    }

    player.score += room.activeQuestion.points;

    clearQuestionTimer(room);
    room.activeQuestion = null;

    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Закрытие вопроса без начисления очков
  socket.on('finish-question', ({ code }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может закрывать вопросы'
        });
      }
      return;
    }

    if (room.activeQuestion) {
      clearQuestionTimer(room);
      room.activeQuestion = null;
    }

    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Новая игра
  socket.on('new-game', ({ code }, callback) => {
    const room = rooms[code];

    if (!isHost(socket, room)) {
      if (callback) {
        callback({
          success: false,
          error: 'Только ведущий может начать новую игру'
        });
      }
      return;
    }

    clearQuestionTimer(room);

    room.previousGameQuestions = [...room.usedQuestions];
    room.usedQuestions = [];
    room.usedCells = [];
    room.categories = [];
    room.activeQuestion = null;

    room.players.forEach(player => {
      player.score = 0;
    });

    saveRoomHistory(room);
    sendRoom(code);

    if (callback) callback({ success: true });
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    console.log('Отключился:', socket.id);

    for (const code in rooms) {
      const room = rooms[code];

      const playerIndex = room.players.findIndex(
        player => player.id === socket.id
      );

      if (playerIndex === -1) continue;

      room.players.splice(playerIndex, 1);

      if (room.players.length === 0) {
        clearQuestionTimer(room);
        delete rooms[code];
        continue;
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }

      sendRoom(code);
    }
  });
});

// Render использует process.env.PORT,
// локально используется порт 3001
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
