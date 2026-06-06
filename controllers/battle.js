const { nanoid } = require("nanoid");

const rooms = {};
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PLAYERS = 2;
const READY_COUNTDOWN_MS = 5000;

function getMaxPlayers(room) {
  return room.battleConfig?.maxPlayers ?? DEFAULT_MAX_PLAYERS;
}

function mergeBattleConfig(room, config) {
  room.battleConfig = {
    level: config.level ?? 50,
    teamSize: config.teamSize ?? 6,
    useItems: config.useItems ?? false,
    itemQuantity: config.itemQuantity ?? 0,
    format: config.format ?? "singles",
    maxPlayers: config.maxPlayers ?? DEFAULT_MAX_PLAYERS,
    generation: config.generation ?? null,
  };
}

function configEnvelope(room) {
  if (!room.battleConfig) {
    return null;
  }
  const c = room.battleConfig;
  return {
    type: "battle:config",
    version: 1,
    payload: {
      level: c.level,
      generation: c.generation,
      useItems: c.useItems,
      itemQuantity: c.itemQuantity,
      teamSize: c.teamSize,
      maxPlayers: c.maxPlayers,
      format: c.format,
    },
  };
}

function matchStartEnvelope(roomKey, room) {
  return {
    type: "battle:matchStart",
    version: 1,
    payload: {
      roomKey,
      startedAt: room.matchStartedAt ?? new Date().toISOString(),
      hostSocketId: room.hostId,
    },
  };
}

function readyStateEnvelope(room) {
  return {
    type: "battle:readyState",
    version: 1,
    payload: {
      readyPlayerIds: [...room.readyPlayers],
      requiredCount: room.users.length,
      allReady:
        room.users.length > 0 &&
        room.users.every((id) => room.readyPlayers.includes(id)),
    },
  };
}

function countdownEnvelope(room) {
  return {
    type: "battle:countdown",
    version: 1,
    payload: {
      seconds: Math.ceil(READY_COUNTDOWN_MS / 1000),
      endsAt: new Date(room.countdownEndsAt).toISOString(),
    },
  };
}

function roomSnapshot(room) {
  const maxPlayers = getMaxPlayers(room);
  const matchStarted =
    room.status === "team-select" || room.status === "in-battle";
  return {
    battleConfig: room.battleConfig,
    status: room.status,
    users: [...room.users],
    playerCount: room.users.length,
    maxPlayers,
    matchStarted,
    readyForTeamSelect: matchStarted,
    readyPlayerIds: [...room.readyPlayers],
    countdownEndsAt: room.countdownEndsAt
      ? new Date(room.countdownEndsAt).toISOString()
      : null,
  };
}

function clearCountdown(room) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
  room.countdownEndsAt = null;
}

function startReadyCountdown(io, roomKey, room) {
  if (room.countdownTimer || room.status === "team-select" || room.status === "in-battle") {
    return;
  }

  room.status = "countdown";
  room.countdownEndsAt = Date.now() + READY_COUNTDOWN_MS;
  io.to(roomKey).emit("gameEvent", countdownEnvelope(room));
  console.log(`⏱️ Room ${roomKey} — countdown started`);

  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    room.status = "team-select";
    room.matchStartedAt = new Date().toISOString();
    io.to(roomKey).emit("gameEvent", matchStartEnvelope(roomKey, room));
    console.log(`▶️ Room ${roomKey} — match started after ready countdown`);
  }, READY_COUNTDOWN_MS);
}

function checkAllReadyAndCountdown(io, roomKey, room) {
  if (room.status !== "ready-queue" && room.status !== "waiting") {
    return;
  }
  const allReady =
    room.users.length >= getMaxPlayers(room) &&
    room.users.every((id) => room.readyPlayers.includes(id));
  if (allReady) {
    startReadyCountdown(io, roomKey, room);
  }
}

function maybeEnterReadyQueue(io, roomKey, room) {
  const maxPlayers = getMaxPlayers(room);
  if (
    room.users.length < maxPlayers ||
    !room.battleConfig ||
    room.status === "countdown" ||
    room.status === "team-select" ||
    room.status === "in-battle"
  ) {
    return;
  }

  room.status = "ready-queue";
  io.to(roomKey).emit("gameEvent", readyStateEnvelope(room));
  console.log(`✅ Room ${roomKey} — lobby full, ready queue open`);
  checkAllReadyAndCountdown(io, roomKey, room);
}

function emitRoomStateToSocket(socket, roomKey, room) {
  const configEvent = configEnvelope(room);
  if (configEvent) {
    socket.emit("gameEvent", configEvent);
  }
  if (room.status === "ready-queue" || room.status === "waiting") {
    socket.emit("gameEvent", readyStateEnvelope(room));
  }
  if (room.status === "countdown" && room.countdownEndsAt) {
    socket.emit("gameEvent", countdownEnvelope(room));
  }
  if (room.status === "team-select" || room.status === "in-battle") {
    socket.emit("gameEvent", matchStartEnvelope(roomKey, room));
  }
}

module.exports = (io, socket) => {
  console.log("🔌 User connected:", socket.userId);

  socket.on("createRoom", (_, cb) => {
    const roomKey = nanoid(6);
    socket.join(roomKey);

    const timer = setTimeout(() => {
      io.to(roomKey).emit("roomExpired");
      delete rooms[roomKey];
      io.in(roomKey).socketsLeave(roomKey);
      console.log(`⌛ Room ${roomKey} expired`);
    }, ROOM_TIMEOUT_MS);

    rooms[roomKey] = {
      hostId: socket.userId,
      users: [socket.userId],
      timer,
      battleConfig: null,
      status: "lobby",
      battleInfo: null,
      readyPlayers: [],
      matchStartedAt: null,
      countdownTimer: null,
      countdownEndsAt: null,
    };

    cb({ roomKey });
    console.log(`🛠️ Room ${roomKey} created by ${socket.userId}`);
  });

  socket.on("joinRoom", (roomKey, cb) => {
    const room = rooms[roomKey];
    if (!room) {
      return cb({ error: "Room not found or expired." });
    }

    const maxPlayers = getMaxPlayers(room);
    const alreadyInRoom = room.users.includes(socket.userId);
    if (!alreadyInRoom && room.users.length >= maxPlayers) {
      return cb({ error: "Room is full." });
    }

    if (!alreadyInRoom) {
      room.users.push(socket.userId);
    }

    socket.join(roomKey);
    if (!alreadyInRoom) {
      socket.to(roomKey).emit("playerJoined", socket.userId);
    }

    emitRoomStateToSocket(socket, roomKey, room);
    maybeEnterReadyQueue(io, roomKey, room);

    cb({
      success: true,
      roomKey,
      ...roomSnapshot(room),
    });
    console.log(`👥 ${socket.userId} joined room ${roomKey}`);
  });

  socket.on("sendMessage", ({ roomKey, message }, cb) => {
    const room = rooms[roomKey];
    if (!room) {
      return cb?.({ error: "Room not found or expired." });
    }

    io.to(roomKey).emit("receiveMessage", {
      senderId: socket.userId,
      message,
      timestamp: new Date().toISOString(),
    });
    cb?.({ success: true });
  });

  socket.on("closeRoom", (roomKey) => {
    const room = rooms[roomKey];
    if (room && room.hostId === socket.userId) {
      clearCountdown(room);
      clearTimeout(room.timer);
      delete rooms[roomKey];
      io.to(roomKey).emit("roomClosed");
      io.in(roomKey).socketsLeave(roomKey);
    }
  });

  socket.on("gameEvent", ({ roomId, data }) => {
    const room = rooms[roomId];
    if (!room || !data?.type) {
      return;
    }

    data.senderId = socket.userId;

    switch (data.type) {
      case "battle:config":
        if (room.hostId !== socket.userId || room.status !== "lobby") {
          return;
        }
        if (data.version === 1 && data.payload) {
          mergeBattleConfig(room, data.payload);
          room.status = "waiting";
          room.readyPlayers = [];
          io.to(roomId).emit("gameEvent", data);
          maybeEnterReadyQueue(io, roomId, room);
        }
        return;

      case "battle:ready":
        if (!room.users.includes(socket.userId)) {
          return;
        }
        if (room.status === "countdown" || room.status === "team-select") {
          return;
        }
        if (!room.readyPlayers.includes(socket.userId)) {
          room.readyPlayers.push(socket.userId);
        }
        if (room.status === "waiting" && room.users.length >= getMaxPlayers(room)) {
          room.status = "ready-queue";
        }
        io.to(roomId).emit("gameEvent", readyStateEnvelope(room));
        checkAllReadyAndCountdown(io, roomId, room);
        return;

      case "battle:matchStart":
        if (room.hostId !== socket.userId) {
          return;
        }
        room.status = "team-select";
        room.matchStartedAt = data.payload?.startedAt ?? new Date().toISOString();
        clearCountdown(room);
        io.to(roomId).emit("gameEvent", data);
        return;

      case "battle:turn":
        io.to(roomId).emit("gameEvent", data);
        return;

      default:
        return;
    }
  });

  socket.on("disconnect", () => {
    for (const [roomKey, room] of Object.entries(rooms)) {
      const index = room.users.indexOf(socket.userId);
      if (index === -1) {
        continue;
      }

      room.users.splice(index, 1);
      room.readyPlayers = room.readyPlayers.filter((id) => id !== socket.userId);

      if (room.status === "countdown") {
        clearCountdown(room);
        if (room.users.length >= getMaxPlayers(room) && room.battleConfig) {
          room.status = "ready-queue";
          io.to(roomKey).emit("gameEvent", readyStateEnvelope(room));
        } else {
          room.status = "waiting";
        }
      } else if (room.status === "ready-queue") {
        io.to(roomKey).emit("gameEvent", readyStateEnvelope(room));
      }

      socket.to(roomKey).emit("playerLeft", socket.userId);

      if (room.hostId === socket.userId || room.users.length === 0) {
        clearCountdown(room);
        clearTimeout(room.timer);
        delete rooms[roomKey];
        io.in(roomKey).socketsLeave(roomKey);
      }
    }
  });
};
