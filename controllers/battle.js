const { nanoid } = require("nanoid");

const rooms = {};
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PLAYERS = 2;

function getMaxPlayers(room) {
  return room.battleConfig?.maxPlayers ?? DEFAULT_MAX_PLAYERS;
}

function mergeBattleConfig(room, data) {
  room.battleConfig = {
    level: data.level ?? room.battleConfig?.level ?? 50,
    teamSize: data.teamSize ?? room.battleConfig?.teamSize ?? 6,
    useItems: data.useItems ?? room.battleConfig?.useItems ?? false,
    itemQuantity: data.itemQuantity ?? room.battleConfig?.itemQuantity ?? 0,
    format: data.format ?? room.battleConfig?.format ?? "singles",
    maxPlayers:
      data.maxPlayers ?? room.battleConfig?.maxPlayers ?? DEFAULT_MAX_PLAYERS,
    generation: data.generation ?? room.battleConfig?.generation ?? null,
  };
}

function roomSnapshot(room) {
  return {
    battleConfig: room.battleConfig,
    status: room.status,
    users: [...room.users],
    maxPlayers: getMaxPlayers(room),
    battleInfo: room.battleInfo,
  };
}

function isGameEventEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.type !== "string") return false;
  if (value.version !== 1) return false;
  if (!value.payload || typeof value.payload !== "object") return false;
  return true;
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

    const payload = {
      senderId: socket.userId,
      message,
      timestamp: new Date().toISOString(),
    };

    io.to(roomKey).emit("receiveMessage", payload);
    cb?.({ success: true });
  });

  socket.on("closeRoom", (roomKey) => {
    const room = rooms[roomKey];
    if (room && room.hostId === socket.userId) {
      clearTimeout(room.timer);
      delete rooms[roomKey];
      io.to(roomKey).emit("roomClosed");
      io.in(roomKey).socketsLeave(roomKey);
      console.log(`🚪 Room ${roomKey} closed by host.`);
    }
  });

  socket.on("gameEvent", ({ roomId, data }) => {
    const room = rooms[roomId];
    if (!room || !data?.type) {
      return;
    }
    if (!isGameEventEnvelope(data)) {
      console.log(`⚠️ Invalid game event payload in room ${roomId}.`);
      return;
    }

    data.senderId = socket.userId;

    switch (data.type) {
      case "battleConfig":
        if (room.hostId !== socket.userId || room.status !== "lobby") {
          return;
        }
        if (data.config) {
          mergeBattleConfig(room, data.config);
          room.status = "waiting";
        }
        break;

      case "playerReady":
        if (!room.readyPlayers.includes(socket.userId)) {
          room.readyPlayers.push(socket.userId);
        }
        break;

      case "battleStart":
        if (room.hostId !== socket.userId) {
          return;
        }
        room.status = "in-battle";
        room.battleInfo = {
          startedAt: new Date().toISOString(),
          turn: 0,
        };
        break;

      case "battleState":
        if (!room.battleInfo) {
          room.battleInfo = { turn: 0, states: {} };
        }
        if (!room.battleInfo.states) {
          room.battleInfo.states = {};
        }
        room.battleInfo.states[socket.userId] = data.field ?? null;
        if (typeof data.field?.turn === "number") {
          room.battleInfo.turn = data.field.turn;
        }
        break;

      case "battleAction":
        if (data.action?.message && room.battleInfo) {
          room.battleInfo.lastMessage = data.action.message;
        }
        break;

      default:
        return;
    }

    io.to(roomId).emit("gameEvent", data);
    console.log(`🎮 ${data.type} in room ${roomId} from ${socket.userId}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.userId);

    for (const [roomKey, room] of Object.entries(rooms)) {
      const index = room.users.indexOf(socket.userId);
      if (index !== -1) {
        room.users.splice(index, 1);
        room.readyPlayers = room.readyPlayers.filter(
          (id) => id !== socket.userId,
        );
        socket.to(roomKey).emit("playerLeft", socket.userId);

        if (room.hostId === socket.userId || room.users.length === 0) {
          clearTimeout(room.timer);
          delete rooms[roomKey];
          io.in(roomKey).socketsLeave(roomKey);
          console.log(
            `🧹 Room ${roomKey} closed due to host disconnect or empty room.`,
          );
        }
      }
    }
  });
};
