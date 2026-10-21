(() => {
  "use strict";

  // This is the API Gateway WebSocket URL for the production stage.
  // Players never need to enter it.
  const WS_URL = "wss://3zbk2uhhuk.execute-api.us-east-1.amazonaws.com/production";
  const TICK_MS = 150;

  const $ = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean) || null;
  const createBtn = $("create-room-btn", "createRoomBtn", "createRoomButton");
  const joinBtn = $("join-room-btn", "joinRoomBtn", "joinRoomButton");
  const saveProfileBtn = $("save-profile-btn");
  const editProfileBtn = $("edit-profile-btn");
  const refreshLeaderboardBtn = $("refresh-leaderboard-btn");
  const personalBestEl = $("personal-best");
  const overallMvpEl = $("overall-mvp");
  const leaderboardListEl = $("leaderboard-list");
  const profileNameInput = $("profile-name");
  const profileAvatarInput = $("profile-avatar");
  const profileSummary = $("profile-summary");
  const profileForm = $("profile-form");
  const roomActions = $("room-actions");
  const lobbyActions = $("lobby-actions");
  const startBtn = $("start-game-btn");
  const newRoomBtn = $("new-room-btn");
  const playerListEl = $("player-list");
  const roomInput = $("room-code", "roomCodeInput", "roomCode");
  const statusEl = $("multiplayer-message", "status", "gameStatus", "statusMessage");
  const connectionEl = $("connection-status");
  const roomEl = $("active-room", "roomDisplay", "roomCodeDisplay");
  const playerEl = $("player-number", "playerDisplay", "playerNumber");
  const scoreEl = $("score", "scoreValue");
  const canvas = $("board", "gameCanvas", "snakeCanvas", "game", "canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;

  let socket = null;
  let connected = false;
  let connectionPromise = null;
  let roomCode = null;
  let player = null;
  let profile = null;
  let profiles = {};
  let state = null;
  let board = { cols: 30, rows: 20 };
  let serverStatus = "disconnected";
  let tickTimer = null;
  let lastVersion = -1;
  let lastTickSent = 0;
  let gameOverShown = false;
  let requestInProgress = false;

  if (canvas) {
    canvas.width = 600;
    canvas.height = 400;
  }

  function status(message) {
    if (statusEl) statusEl.textContent = message;
    if (connectionEl) {
      connectionEl.textContent = connected ? "Connected" :
        (socket?.readyState === WebSocket.CONNECTING ? "Connecting…" : "Not connected");
    }
    console.log("[Snake]", message);
  }

  function send(action, extra = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      status("Not connected. Please try again.");
      return false;
    }
    socket.send(JSON.stringify({ action, ...extra }));
    return true;
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) {
      connected = true;
      return Promise.resolve();
    }
    if (socket?.readyState === WebSocket.CONNECTING && connectionPromise) {
      return connectionPromise;
    }

    status("Connecting to multiplayer server…");
    connectionPromise = new Promise((resolve, reject) => {
      let settled = false;
      try {
        socket = new WebSocket(WS_URL);
      } catch (error) {
        connectionPromise = null;
        status("Could not open the WebSocket connection.");
        reject(error);
        return;
      }

      const failBeforeOpen = message => {
        if (settled) return;
        settled = true;
        connectionPromise = null;
        reject(new Error(message));
      };

      socket.onopen = () => {
        connected = true;
        serverStatus = "waiting";
        settled = true;
        status("Connected. Preparing your room…");
        send("getLeaderboard", { profileId: profile?.id || null });
        resolve();
      };

      socket.onmessage = event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          console.error("Invalid server message:", event.data);
          return;
        }
        handleMessage(message);
      };

      socket.onerror = error => {
        console.error("WebSocket error:", error);
        status("Connection failed. Check API Gateway deployment and Lambda logs.");
        failBeforeOpen("WebSocket connection failed");
      };

      socket.onclose = () => {
        connected = false;
        connectionPromise = null;
        stopTickSender();
        serverStatus = "disconnected";
        status("Disconnected from the game server. Refresh to try again.");
        if (!settled) failBeforeOpen("WebSocket closed before connecting");
      };
    });
    return connectionPromise;
  }

  function loadProfile() {
    try { return JSON.parse(localStorage.getItem("snakePlayerProfile") || "null"); }
    catch (_) { return null; }
  }

  function saveProfile() {
    const name = (profileNameInput?.value || "").trim().replace(/\s+/g, " ");
    const avatar = profileAvatarInput?.value || "🐍";
    if (name.length < 2) {
      status("Enter a display name with at least 2 characters.");
      profileNameInput?.focus();
      return;
    }
    const previous = profile || loadProfile() || {};
    profile = { id: previous.id || (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`), name: name.slice(0, 20), avatar };
    localStorage.setItem("snakePlayerProfile", JSON.stringify(profile));
    if (connected) send("updateProfile", { profile });
    if (profileSummary) profileSummary.textContent = `${profile.avatar} ${profile.name} — profile saved on this browser.`;
    if (profileForm) profileForm.classList.add("hidden");
    if (roomActions) roomActions.classList.remove("hidden");
    if (editProfileBtn) editProfileBtn.classList.remove("hidden");
    if (saveProfileBtn) saveProfileBtn.textContent = "Save profile";
    status("Profile saved. Create a room or join your friend's room.");
  }

  async function createRoom() {
    if (!profile) { status("Save your player profile first."); return; }
    if (requestInProgress) return;
    requestInProgress = true;
    if (createBtn) createBtn.disabled = true;
    try {
      await connect();
      resetLocal();
      send("createRoom", { profile });
      status("Creating room…");
    } catch (error) {
      console.error(error);
      status("Could not connect. Check the deployed WebSocket API and try refreshing.");
    } finally {
      requestInProgress = false;
      if (createBtn) createBtn.disabled = false;
    }
  }

  async function joinRoom() {
    if (!profile) { status("Save your player profile first."); return; }
    if (requestInProgress) return;
    const code = roomInput?.value.trim().toUpperCase() || "";
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      status("Enter the 6-character room code.");
      roomInput?.focus();
      return;
    }
    requestInProgress = true;
    if (joinBtn) joinBtn.disabled = true;
    try {
      await connect();
      resetLocal();
      roomCode = code;
      send("joinRoom", { roomCode: code, profile });
      status(`Joining room ${code}…`);
    } catch (error) {
      console.error(error);
      status("Could not connect. Check the deployed WebSocket API and try refreshing.");
    } finally {
      requestInProgress = false;
      if (joinBtn) joinBtn.disabled = false;
    }
  }

  async function startNewRoom() {
    // Open a fresh WebSocket so the old finished room connection is cleaned up.
    stopTickSender();
    const oldSocket = socket;
    socket = null;
    connected = false;
    connectionPromise = null;
    resetLocal();
    if (roomActions) roomActions.classList.remove("hidden");
    if (lobbyActions) lobbyActions.classList.add("hidden");
    if (createBtn) createBtn.classList.remove("hidden");
    if (joinBtn) joinBtn.classList.remove("hidden");
    if (roomInput) roomInput.classList.remove("hidden");
    if (newRoomBtn) newRoomBtn.classList.add("hidden");
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) {
      try { oldSocket.close(1000, "Starting a new room"); } catch (_) {}
    }
    status("Ready for a new game. Create a room or enter your friend's room code.");
  }

  function handleMessage(message) {
    switch (message.action) {
      case "roomCreated":
      case "roomJoined":
        roomCode = message.roomCode || roomCode;
        player = message.player || player;
        profiles = message.profiles || profiles;
        serverStatus = message.status || "waiting";
        enterLobby();
        updateRoomInfo();
        status(`Room ${roomCode}: you are ${player}. Share the code with the other player.`);
        break;

      case "playerJoined":
        roomCode = message.roomCode || roomCode;
        if (message.player) player = message.player;
        profiles = message.profiles || profiles;
        serverStatus = message.status || serverStatus;
        enterLobby();
        updateRoomInfo();
        status(serverStatus === "playing" ? "Game started!" : "Both players are here. The room creator can start the game.");
        break;

      case "gameStarted":
        serverStatus = "playing";
        if (message.profiles) profiles = message.profiles;
        updateRoomInfo();
        status("Game started! Good luck.");
        break;

      case "state":
        if (typeof message.version === "number" && message.version < lastVersion) return;
        lastVersion = message.version ?? lastVersion;
        roomCode = message.roomCode || roomCode;
        serverStatus = message.status || serverStatus;
        board = message.board || board;
        state = message.state || state;
        updateRoomInfo();
        updateScore();
        if (serverStatus === "playing") startTickSender();
        else stopTickSender();
        updateRoomInfo();
        draw();
        break;

      case "gameOver":
        serverStatus = "finished";
        stopTickSender();
        if (message.scores && state) state.scores = message.scores;
        updateScore();
        updateRoomInfo();
        if (newRoomBtn) newRoomBtn.classList.remove("hidden");
        send("getLeaderboard", { profileId: profile?.id || null });
        draw();
        if (!gameOverShown) {
          gameOverShown = true;
          const scores = message.scores || state?.scores;
          const scoreText = scores
            ? ` Final score — P1 ${scores.player1 ?? 0}, P2 ${scores.player2 ?? 0}.`
            : "";
          status((message.message || "Game over.") + scoreText);
        }
        break;

      case "error":
        status(message.message || "The server reported an error.");
        break;

      case "leaderboard":
        renderLeaderboard(message);
        break;

      case "pong":
        break;

      default:
        console.log("Server message:", message);
    }
  }

  function renderLeaderboard(message) {
    const personal = message.personalBest || 0;
    if (personalBestEl) personalBestEl.textContent = String(personal);
    const mvp = message.mvp;
    if (overallMvpEl) overallMvpEl.textContent = mvp
      ? `${mvp.avatar || "🐍"} ${mvp.name || "Player"} — ${Number(mvp.score || 0)} points`
      : "No champion recorded yet.";
    if (leaderboardListEl) {
      leaderboardListEl.replaceChildren();
      const rows = Array.isArray(message.leaderboard) ? message.leaderboard : [];
      if (!rows.length) {
        const li = document.createElement("li"); li.textContent = "No scores recorded yet."; leaderboardListEl.appendChild(li);
      } else {
        rows.forEach((entry, index) => {
          const li = document.createElement("li");
          li.textContent = `${entry.avatar || "🐍"} ${entry.name || "Player"} — ${Number(entry.score || 0)} points`;
          leaderboardListEl.appendChild(li);
        });
      }
    }
  }

  async function editProfile() {
    if (roomCode && serverStatus !== "finished") {
      status("Finish or leave your current room before editing your profile.");
      return;
    }
    if (profileForm) profileForm.classList.remove("hidden");
    if (profileNameInput && profile) profileNameInput.value = profile.name || "";
    if (profileAvatarInput && profile) profileAvatarInput.value = profile.avatar || "🐍";
    if (saveProfileBtn) saveProfileBtn.textContent = "Save profile changes";
    if (editProfileBtn) editProfileBtn.classList.add("hidden");
    status("Edit your name or avatar, then save your profile.");
  }

  function enterLobby() {
    if (newRoomBtn) newRoomBtn.classList.add("hidden");
    if (roomActions) roomActions.classList.add("hidden");
    if (lobbyActions) lobbyActions.classList.add("hidden");
    if (createBtn) createBtn.classList.add("hidden");
    if (joinBtn) joinBtn.classList.add("hidden");
    if (roomInput) roomInput.classList.add("hidden");
    updateRoomInfo();
  }

  function updateRoomInfo() {
    if (roomEl) roomEl.textContent = roomCode || "—";
    if (playerEl) playerEl.textContent = player || "—";
    if (playerListEl) {
      const names = Object.entries(profiles || {}).map(([key, p]) => `${p?.avatar || "🐍"} ${p?.name || key}`);
      playerListEl.textContent = names.length ? names.join(" · ") : "—";
    }
    if (newRoomBtn) newRoomBtn.classList.toggle("hidden", serverStatus !== "finished");
    const bothPlayers = Boolean(profiles.player1 && profiles.player2);
    if (lobbyActions) lobbyActions.classList.toggle("hidden", !bothPlayers || serverStatus === "playing" || serverStatus === "finished");
    if (startBtn) {
      startBtn.disabled = serverStatus !== "waiting" || !bothPlayers || player !== "player1";
      startBtn.textContent = serverStatus === "playing" ? "Game started" : (player === "player1" ? "Start game" : "Waiting for host");
      startBtn.classList.toggle("hidden", serverStatus === "playing" || serverStatus === "finished");
    }
  }

  async function startGame() {
    if (player !== "player1") { status("Only the room creator can start the game."); return; }
    if (!profiles.player1 || !profiles.player2) { status("Wait until both players have joined."); return; }
    send("startGame");
    status("Starting game…");
  }

  function updateScore() {
    if (!scoreEl || !state?.scores || !player) return;
    scoreEl.textContent = String(state.scores[player] ?? 0);
  }

  function resetLocal() {
    stopTickSender();
    roomCode = null;
    player = null;
    profiles = {};
    state = null;
    serverStatus = "waiting";
    lastVersion = -1;
    lastTickSent = 0;
    gameOverShown = false;
    updateRoomInfo();
    if (scoreEl) scoreEl.textContent = "0";
    draw();
  }

  function startTickSender() {
    if (tickTimer || serverStatus !== "playing") return;
    // Clients request ticks, but Lambda is authoritative and enforces cadence.
    tickTimer = setInterval(() => {
      if (serverStatus !== "playing" || !connected) return;
      const now = Date.now();
      if (now - lastTickSent >= TICK_MS - 10) {
        lastTickSent = now;
        send("tick");
      }
    }, Math.max(50, Math.floor(TICK_MS / 2)));
  }

  function stopTickSender() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function setDirection(direction) {
    if (!connected || serverStatus !== "playing" || !player) return;
    send("move", { direction });
  }

  function draw() {
    if (!ctx || !canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const cols = board.cols || 30;
    const rows = board.rows || 20;
    const cellW = width / cols;
    const cellH = height / rows;

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, height); ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * cellH); ctx.lineTo(width, y * cellH); ctx.stroke();
    }

    if (state?.food) {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc((state.food.x + 0.5) * cellW, (state.food.y + 0.5) * cellH,
        Math.min(cellW, cellH) * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }

    const snakes = state?.snakes || {};
    for (const [name, snake] of Object.entries(snakes)) {
      ctx.fillStyle = name === "player1" ? "#16a34a" : "#2563eb";
      (snake || []).forEach((part, index) => {
        ctx.globalAlpha = index === 0 ? 1 : 0.72;
        ctx.fillRect(part.x * cellW + 1, part.y * cellH + 1, cellW - 2, cellH - 2);
      });
    }
    ctx.globalAlpha = 1;

    if (serverStatus !== "playing") {
      ctx.fillStyle = "rgba(17,24,39,0.72)";
      ctx.fillRect(0, height / 2 - 27, width, 54);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 19px Arial";
      let label = "Create or join a room";
      if (serverStatus === "finished") label = "GAME OVER";
      else if (state && profiles.player1 && profiles.player2) label = "Waiting for host to start…";
      else if (state) label = "Waiting for player 2…";
      ctx.fillText(label, width / 2, height / 2 + 7);
    }
  }

  document.addEventListener("keydown", event => {
    const key = event.key.toLowerCase();
    const map = {
      arrowup: "up", w: "up",
      arrowdown: "down", s: "down",
      arrowleft: "left", a: "left",
      arrowright: "right", d: "right"
    };
    if (!map[key]) return;

    // Do not steal WASD/arrow keys while the player is typing in a form field.
    const target = event.target;
    const isTyping = target && (
      target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)
    );
    if (isTyping || serverStatus !== "playing") return;

    event.preventDefault();
    setDirection(map[key]);
  });

  document.querySelectorAll("[data-dir]").forEach(button => {
    button.addEventListener("click", () => setDirection(button.dataset.dir));
  });

  saveProfileBtn?.addEventListener("click", saveProfile);
  editProfileBtn?.addEventListener("click", editProfile);
  refreshLeaderboardBtn?.addEventListener("click", async () => { try { await connect(); send("getLeaderboard", { profileId: profile?.id || null }); } catch (_) {} });
  startBtn?.addEventListener("click", startGame);
  newRoomBtn?.addEventListener("click", startNewRoom);
  createBtn?.addEventListener("click", createRoom);
  joinBtn?.addEventListener("click", joinRoom);
  roomInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") joinRoom();
  });

  const savedProfile = loadProfile();
  if (savedProfile?.name) {
    profile = { ...savedProfile, id: savedProfile.id || (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`) };
    localStorage.setItem("snakePlayerProfile", JSON.stringify(profile));
    if (profileNameInput) profileNameInput.value = savedProfile.name;
    if (profileAvatarInput) profileAvatarInput.value = savedProfile.avatar || "🐍";
    if (profileSummary) profileSummary.textContent = `${profile.avatar || "🐍"} ${profile.name} — saved profile loaded.`;
    if (profileForm) profileForm.classList.add("hidden");
    if (roomActions) roomActions.classList.remove("hidden");
    if (editProfileBtn) editProfileBtn.classList.remove("hidden");
    status("Profile loaded. Create a room or join your friend's room.");
    connect().then(() => send("getLeaderboard", { profileId: profile.id })).catch(() => {});
  } else {
    status("Save your profile before creating or joining a room.");
  }
  draw();

  window.snakeMultiplayer = {
    connect, createRoom, joinRoom,
    getState: () => ({ connected, roomCode, player, serverStatus, lastVersion, state })
  };
})();
