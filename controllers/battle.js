const { nanoid } = require("nanoid");
const battleEngine = require("./battle-engine");

const rooms = {};
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PLAYERS = 2;
const COUNTDOWN_MS = 3000;

const ALLOWED_GAME_EVENT_TYPES = new Set([
  "battle:config",
  "battle:turn",
  "battle:matchStart",
  "battle:ready",
  "battle:readyState",
  "battle:countdown",
  "battle:teamLock",
  "battle:stateUpdate",
  "battle:forfeit",
  "battle:switch",
  "battle:item",
  "battle:rematch",
]);

function isGameEventEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.type !== "string") return false;
  if (!ALLOWED_GAME_EVENT_TYPES.has(value.type)) return false;
  if (value.version !== 1) return false;
  if (!value.payload || typeof value.payload !== "object") return false;
  return true;
}

function getMaxPlayers(room) {
  return room.battleConfig?.maxPlayers ?? DEFAULT_MAX_PLAYERS;
}

function mergeBattleConfig(room, payload) {
  const useItems = payload.useItems ?? room.battleConfig?.useItems ?? false;
  const itemSlotCount =
    payload.itemSlotCount ??
    payload.itemQuantity ??
    room.battleConfig?.itemSlotCount ??
    room.battleConfig?.itemQuantity ??
    (useItems ? 6 : 0);

  room.battleConfig = {
    level: payload.level ?? room.battleConfig?.level ?? 50,
    teamSize: payload.teamSize ?? room.battleConfig?.teamSize ?? 6,
    useItems,
    itemQuantity: itemSlotCount,
    itemSlotCount,
    itemStackLimit:
      payload.itemStackLimit ?? room.battleConfig?.itemStackLimit ?? (useItems ? 3 : 0),
    totalItemPool:
      payload.totalItemPool ?? room.battleConfig?.totalItemPool ?? (useItems ? 10 : 0),
    allowedItemTypes:
      payload.allowedItemTypes ??
      room.battleConfig?.allowedItemTypes ??
      (useItems ? ["healing", "stat"] : []),
    format: payload.format ?? room.battleConfig?.format ?? "singles",
    maxPlayers:
      payload.maxPlayers ??
      room.battleConfig?.maxPlayers ??
      DEFAULT_MAX_PLAYERS,
  };
}

function configReplayPayload(room) {
  const c = room.battleConfig;
  if (!c) return null;
  return {
    level: c.level,
    itemQuantity: c.itemSlotCount ?? c.itemQuantity,
    useItems: c.useItems,
    teamSize: c.teamSize,
    maxPlayers: c.maxPlayers,
    format: c.format,
    allowedItemTypes: c.allowedItemTypes,
    itemSlotCount: c.itemSlotCount ?? c.itemQuantity,
    itemStackLimit: c.itemStackLimit,
    totalItemPool: c.totalItemPool,
  };
}

function roomSnapshot(room, roomKey) {
  return {
    success: true,
    roomKey,
    battleConfig: room.battleConfig,
    status: room.status,
    users: [...room.users],
    playerCount: room.users.length,
    maxPlayers: getMaxPlayers(room),
    matchStarted: !!room.matchStartedAt,
    readyForTeamSelect:
      room.status === "team-select" || !!room.matchStartedAt,
    readyPlayerIds: [...room.readyPlayers],
    countdownEndsAt: room.countdownEndsAt ?? null,
  };
}

function presencePayload(room) {
  const maxPlayers = getMaxPlayers(room);
  return {
    readyPlayerIds: [...room.readyPlayers],
    requiredCount: maxPlayers,
    allReady: false,
    playerCount: room.users.length,
    maxPlayers,
  };
}

function broadcastReadyState(io, roomId, room) {
  const maxPlayers = getMaxPlayers(room);
  const allReady =
    room.users.length >= maxPlayers &&
    room.readyPlayers.length >= maxPlayers;

  io.to(roomId).emit("gameEvent", {
    type: "battle:readyState",
    version: 1,
    payload: {
      readyPlayerIds: [...room.readyPlayers],
      requiredCount: maxPlayers,
      allReady,
      playerCount: room.users.length,
      maxPlayers,
    },
  });

  if (allReady && !room.countdownEndsAt && !room.matchStartedAt) {
    startMatchCountdown(io, roomId, room);
  }
}

function startMatchCountdown(io, roomId, room) {
  const endsAt = new Date(Date.now() + COUNTDOWN_MS).toISOString();
  room.countdownEndsAt = endsAt;

  io.to(roomId).emit("gameEvent", {
    type: "battle:countdown",
    version: 1,
    payload: {
      seconds: Math.ceil(COUNTDOWN_MS / 1000),
      endsAt,
    },
  });

  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
  }

  room.countdownTimer = setTimeout(() => {
    const current = rooms[roomId];
    if (!current || current.matchStartedAt) {
      return;
    }
    current.matchStartedAt = new Date().toISOString();
    current.status = "team-select";
    current.countdownEndsAt = null;

    io.to(roomId).emit("gameEvent", {
      type: "battle:matchStart",
      version: 1,
      payload: {
        roomKey: roomId,
        startedAt: current.matchStartedAt,
        hostSocketId: current.hostId,
      },
    });
    console.log(`▶️ Match start in room ${roomId}`);
  }, COUNTDOWN_MS);
}

function broadcastBattleState(io, roomId, room) {
  const payload = battleEngine.buildStatePayload(room);
  io.to(roomId).emit("gameEvent", {
    type: "battle:stateUpdate",
    version: 1,
    payload,
  });
}

function broadcastRoomPresence(io, roomId, room) {
  io.to(roomId).emit("gameEvent", {
    type: "battle:readyState",
    version: 1,
    payload: presencePayload(room),
  });
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
      countdownEndsAt: null,
      countdownTimer: null,
    };

    const room = rooms[roomKey];
    cb({ roomKey, ...roomSnapshot(room, roomKey) });
    console.log(`🛠️ Room ${roomKey} created by ${socket.userId}`);
  });

  socket.on("joinRoom", (roomKey, cb) => {
    const key = String(roomKey ?? "").trim();
    if (!key) {
      return cb({ error: "Room code is required." });
    }

    const room = rooms[key];
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
      socket.to(key).emit("playerJoined", socket.userId);
      broadcastRoomPresence(io, key, room);
    }

    socket.join(key);

    cb(roomSnapshot(room, key));

    if (room.battleConfig) {
      const replay = configReplayPayload(room);
      if (replay) {
        socket.emit("gameEvent", {
          type: "battle:config",
          version: 1,
          payload: replay,
        });
      }
    }

    console.log(
      `👥 ${socket.userId} joined room ${key} (${room.users.length}/${maxPlayers})`,
    );
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
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
      }
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

    if (data.type === "battle:config" && isGameEventEnvelope(data)) {
      if (room.hostId !== socket.userId) {
        return;
      }
      mergeBattleConfig(room, data.payload);
      room.status = "waiting";
      io.to(roomId).emit("gameEvent", data);
      console.log(`⚙️ Battle config saved for room ${roomId}:`, room.battleConfig);
      return;
    }

    if (data.type === "battle:ready" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId) || room.matchStartedAt) {
        return;
      }
      if (!room.readyPlayers.includes(socket.userId)) {
        room.readyPlayers.push(socket.userId);
      }
      broadcastReadyState(io, roomId, room);
      return;
    }

    if (data.type === "battle:matchStart" && isGameEventEnvelope(data)) {
      if (room.hostId !== socket.userId) {
        return;
      }
      room.matchStartedAt = data.payload?.startedAt ?? new Date().toISOString();
      room.status = "team-select";
      battleEngine.ensureBattleInfo(room);
      io.to(roomId).emit("gameEvent", data);
      console.log(`▶️ Match start in room ${roomId}`);
      return;
    }

    if (data.type === "battle:teamLock" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId)) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            turn: 0,
            message: "Reconnect to the room before locking your team.",
            actives: {},
            teamRemaining: {},
            awaitingMoves: [],
            lockedPlayers: room.battleInfo?.lockedPlayers ?? [],
            winnerId: null,
            battleStarted: false,
          },
        });
        return;
      }
      if (room.status === "finished") {
        return;
      }
      const battlers = data.payload?.battlers;
      const bagItems = data.payload?.bagItems;
      const result = battleEngine.lockTeam(
        room,
        socket.userId,
        battlers,
        bagItems,
      );
      if (result.error) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            turn: 0,
            message: result.error,
            actives: {},
            teamRemaining: {},
            awaitingMoves: [],
            lockedPlayers: room.battleInfo?.lockedPlayers ?? [],
            winnerId: null,
          },
        });
        return;
      }
      broadcastBattleState(io, roomId, room);
      if (result.started) {
        console.log(`⚔️ Battle started in room ${roomId}`);
      }
      return;
    }

    if (data.type === "battle:turn" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId) || room.status !== "in-battle") {
        return;
      }
      const { moveId, turnNumber } = data.payload ?? {};
      const result = battleEngine.submitMove(
        room,
        socket.userId,
        moveId,
        turnNumber,
      );
      if (result.error) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            turn: room.battleInfo?.turn ?? 0,
            message: result.error,
            actives: battleEngine.buildStatePayload(room).actives,
            teamRemaining: battleEngine.buildStatePayload(room).teamRemaining,
            awaitingMoves: battleEngine.buildStatePayload(room).awaitingMoves,
            lockedPlayers: room.battleInfo?.lockedPlayers ?? [],
            winnerId: room.battleInfo?.winnerId ?? null,
          },
        });
        return;
      }
      broadcastBattleState(io, roomId, room);
      if (result.winnerId) {
        console.log(`🏆 Winner in room ${roomId}: ${result.winnerId}`);
      }
      return;
    }

    if (data.type === "battle:forfeit" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId) || room.status !== "in-battle") {
        return;
      }
      const result = battleEngine.forfeitMatch(room, socket.userId);
      if (result.error) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            turn: room.battleInfo?.turn ?? 0,
            message: result.error,
            actives: battleEngine.buildStatePayload(room).actives,
            teamRemaining: battleEngine.buildStatePayload(room).teamRemaining,
            awaitingMoves: [],
            lockedPlayers: room.battleInfo?.lockedPlayers ?? [],
            winnerId: room.battleInfo?.winnerId ?? null,
          },
        });
        return;
      }
      broadcastBattleState(io, roomId, room);
      console.log(`🏳️ Forfeit in room ${roomId}; winner ${result.winnerId}`);
      return;
    }

    if (data.type === "battle:switch" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId) || room.status !== "in-battle") {
        return;
      }
      const { pokemonIndex, turnNumber } = data.payload ?? {};
      const result = battleEngine.submitSwitch(
        room,
        socket.userId,
        pokemonIndex,
        turnNumber,
      );
      if (result.error) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            ...battleEngine.buildStatePayload(room),
            message: result.error,
          },
        });
        return;
      }
      broadcastBattleState(io, roomId, room);
      if (result.winnerId) {
        console.log(`🏆 Winner in room ${roomId}: ${result.winnerId}`);
      }
      return;
    }

    if (data.type === "battle:item" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId) || room.status !== "in-battle") {
        return;
      }
      const { itemId, turnNumber } = data.payload ?? {};
      const result = battleEngine.submitItem(
        room,
        socket.userId,
        itemId,
        turnNumber,
      );
      if (result.error) {
        socket.emit("gameEvent", {
          type: "battle:stateUpdate",
          version: 1,
          payload: {
            ...battleEngine.buildStatePayload(room),
            message: result.error,
          },
        });
        return;
      }
      broadcastBattleState(io, roomId, room);
      if (result.winnerId) {
        console.log(`🏆 Winner in room ${roomId}: ${result.winnerId}`);
      }
      return;
    }

    if (data.type === "battle:rematch" && isGameEventEnvelope(data)) {
      if (!room.users.includes(socket.userId)) {
        return;
      }
      battleEngine.resetBattle(room);
      io.to(roomId).emit("gameEvent", {
        type: "battle:rematch",
        version: 1,
        payload: {},
      });
      console.log(`🔄 Rematch started in room ${roomId}`);
      return;
    }

    switch (data.type) {
      case "battle:config":
        if (room.hostId !== socket.userId || room.status !== "lobby") {
          return;
        }
        if (data.version === 1 && data.payload) {
          mergeBattleConfig(room, data.payload);
          room.status = "waiting";
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
        broadcastReadyState(io, roomId, room);
        return;

      case "teamSelect":
        if (room.status !== "team-select" && room.status !== "waiting") {
          return;
        }
        if (!room.battleInfo) {
          room.battleInfo = { selections: {} };
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

    io.to(roomId).emit("gameEvent", data);
    console.log(`🎮 ${data.type} in room ${roomId} from ${socket.userId}`);
  });

  socket.on("disconnect", () => {
    for (const [roomKey, room] of Object.entries(rooms)) {
      const index = room.users.indexOf(socket.userId);
      if (index !== -1) {
        room.users.splice(index, 1);
        room.readyPlayers = room.readyPlayers.filter(
          (id) => id !== socket.userId,
        );
        if (room.countdownTimer) {
          clearTimeout(room.countdownTimer);
          room.countdownTimer = null;
          room.countdownEndsAt = null;
        }
        socket.to(roomKey).emit("playerLeft", socket.userId);

        if (room.hostId === socket.userId || room.users.length === 0) {
          if (room.countdownTimer) {
            clearTimeout(room.countdownTimer);
          }
          clearTimeout(room.timer);
          delete rooms[roomKey];
          io.in(roomKey).socketsLeave(roomKey);
          console.log(
            `🧹 Room ${roomKey} closed due to host disconnect or empty room.`,
          );
        } else {
          broadcastRoomPresence(io, roomKey, room);
        }
      }
    }
  });
};
