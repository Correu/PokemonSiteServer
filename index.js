const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors()); // optional: adjust to your client origin

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // or specify your frontend URL
    methods: ["GET", "POST"],
  },
});

// Socket.IO logic
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on("joinBattle", (battleId) => {
    socket.join(battleId);
    io.to(battleId).emit("playerJoined", socket.id);
  });

  socket.on("makeMove", ({ battleId, move }) => {
    socket.to(battleId).emit("opponentMove", move);
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });

  socket.on("test", () => {
    console.log("test");
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
