const { nanoid } = require("nanoid");

const rooms = {};
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PLAYERS = 2;

const ALLOWED_GAME_EVENT_TYPES = new Set([
  "battle:config",
  "battle:turn",
  "battle:matchStart",
]);

function isGameEventEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.type !== "string") return false;
  if (!ALLOWED_GAME_EVENT_TYPES.has(value.type)) return false;
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
    cb({ success: true, roomKey });
    // Late joiners miss the initial battle:config broadcast; replay from stored config.
    if (room.battleConfig) {
      socket.emit("gameEvent", {
        type: "battle:config",
        version: 1,
        payload: {
          level: room.battleConfig.level,
          itemQuantity: room.battleConfig.itemQuantity,
          generation: room.battleConfig.generation,
          useItems: room.battleConfig.useItems,
        },
      });
    }
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

    data.senderId = socket.userId;

    switch (data.type) {
      case "battleConfig":
        if (room.hostId !== socket.userId || room.status !== "lobby") {
          return;
        }
        if (data.config) {
          mergeBattleConfig(room, data.config);
          room.status = "waiting";
          maybeBroadcastAllPlayersConnected(io, roomId, room);
        }
        break;

      case "playerReady":
        if (!room.readyPlayers.includes(socket.userId)) {
          room.readyPlayers.push(socket.userId);
        }
        break;

      case "teamSelect":
        if (room.status !== "team-select" && room.status !== "waiting") {
          return;
        }
        if (!room.battleInfo) {
          room.battleInfo = { selections: {} };
        }
        if (!room.battleInfo.selections) {
          room.battleInfo.selections = {};
        }
        room.battleInfo.selections[socket.userId] = data.battler ?? null;
        break;

      case "battleStart":
        if (room.hostId !== socket.userId) {
          return;
        }
        room.status = "in-battle";
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

      case "allPlayersConnected":
        return;

      default:
        return;
    }

    if (data.type === "battle:matchStart") {
      room.matchStartedAt = data.payload?.startedAt ?? null;
      console.log(`▶️ Match start in room ${roomId}`);
    }

    // Broadcast the game event to all users in the room
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
