const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");
const statusEl = document.getElementById("status");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("overlay-title");
const messageEl = document.getElementById("overlay-message");
const startBtn = document.getElementById("start-btn");
const pauseBtn = document.getElementById("pause-btn");
const restartBtn = document.getElementById("restart-btn");
const profileSelect = document.getElementById("profile-select");
const profileForm = document.getElementById("profile-form");
const profileNameInput = document.getElementById("profile-name");
const profileMessage = document.getElementById("profile-message");

const cells = 20;
const cellSize = canvas.width / cells;
const directions = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

let snake;
let food;
let direction;
let nextDirection;
let score = 0;
let best = 0;
let profiles = [];
let activeProfileId = "";
let timer = null;
let state = "ready";

try {
  const storedProfiles = JSON.parse(localStorage.getItem("snake-profiles") || "[]");
  if (Array.isArray(storedProfiles)) {
    profiles = storedProfiles.filter(profile =>
      profile && typeof profile.id === "string" &&
      typeof profile.name === "string" && profile.name.trim()
    ).map(profile => ({
      id: profile.id,
      name: profile.name.trim().slice(0, 20),
      best: Math.max(0, Number(profile.best) || 0)
    }));
  }

  if (profiles.length === 0) {
    profiles.push({
      id: "player-1",
      name: "Player 1",
      best: Number(localStorage.getItem("snake-best")) || 0
    });
  }

  activeProfileId = localStorage.getItem("snake-active-profile") || profiles[0].id;
} catch {
  profiles = [{ id: "player-1", name: "Player 1", best: 0 }];
  activeProfileId = profiles[0].id;
}

if (!profiles.some(profile => profile.id === activeProfileId)) {
  activeProfileId = profiles[0].id;
}

function saveProfiles() {
  try {
    localStorage.setItem("snake-profiles", JSON.stringify(profiles));
    localStorage.setItem("snake-active-profile", activeProfileId);
  } catch {
    // Profiles remain usable for the current page if storage is unavailable.
  }
}

function renderProfiles() {
  profileSelect.replaceChildren();

  profiles.forEach(profile => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    profileSelect.append(option);
  });

  profileSelect.value = activeProfileId;
  best = profiles.find(profile => profile.id === activeProfileId).best;
  bestEl.textContent = best;
}

function setProfileControlsDisabled(disabled) {
  profileSelect.disabled = disabled;
  profileNameInput.disabled = disabled;
  profileForm.querySelector("button").disabled = disabled;
}

profileSelect.addEventListener("change", () => {
  activeProfileId = profileSelect.value;
  profileMessage.textContent = "";
  renderProfiles();
  saveProfiles();
});

profileForm.addEventListener("submit", event => {
  event.preventDefault();
  const name = profileNameInput.value.trim();

  if (!name) {
    profileMessage.textContent = "Enter a profile name.";
    return;
  }

  if (profiles.some(profile => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    profileMessage.textContent = "That profile already exists.";
    return;
  }

  const profile = {
    id: `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: name.slice(0, 20),
    best: 0
  };
  profiles.push(profile);
  activeProfileId = profile.id;
  profileNameInput.value = "";
  profileMessage.textContent = "";
  renderProfiles();
  saveProfiles();
});

renderProfiles();

function resetGame() {
  snake = [
    { x: 9, y: 10 },
    { x: 8, y: 10 },
    { x: 7, y: 10 }
  ];

  direction = directions.right;
  nextDirection = directions.right;
  score = 0;

  scoreEl.textContent = score;
  statusEl.textContent = "Ready to play";
  placeFood();
  draw();
}

function placeFood() {
  do {
    food = {
      x: Math.floor(Math.random() * cells),
      y: Math.floor(Math.random() * cells)
    };
  } while (
    snake.some(part => part.x === food.x && part.y === food.y)
  );
}

function drawCell(x, y, color, inset = 1.5) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(
    x * cellSize + inset,
    y * cellSize + inset,
    cellSize - inset * 2,
    cellSize - inset * 2,
    4
  );
  ctx.fill();
}

function draw() {
  ctx.fillStyle = "#101b14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw a subtle grid.
  ctx.strokeStyle = "#19271d";
  ctx.lineWidth = 1;

  for (let i = 0; i <= cells; i++) {
    const p = i * cellSize;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
    ctx.stroke();
  }

  // Draw food.
  ctx.fillStyle = "#ff6b6b";
  ctx.beginPath();
  ctx.arc(
    food.x * cellSize + cellSize / 2,
    food.y * cellSize + cellSize / 2,
    cellSize * 0.34,
    0,
    Math.PI * 2
  );
  ctx.fill();

  // Draw snake.
  snake.forEach((part, index) => {
    drawCell(
      part.x,
      part.y,
      index === 0 ? "#a4f5bb" : "#55c982"
    );
  });

  // Eyes on the head.
  const head = snake[0];
  const eyeX = head.x * cellSize + cellSize / 2;
  const eyeY = head.y * cellSize + cellSize / 2;

  ctx.fillStyle = "#102117";

  for (const side of [-1, 1]) {
    const offset = cellSize * 0.17;
    const forward = cellSize * 0.18;

    ctx.beginPath();
    ctx.arc(
      eyeX + direction.x * forward + direction.y * side * offset,
      eyeY + direction.y * forward + direction.x * side * offset,
      1.8,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

function startGame() {
  if (state === "over") {
    resetGame();
  }

  if (state === "running") return;

  state = "running";
  overlay.classList.add("hidden");
  pauseBtn.disabled = false;
  pauseBtn.textContent = "Pause";
  statusEl.textContent = "Playing";
  setProfileControlsDisabled(true);

  clearInterval(timer);
  timer = setInterval(tick, 120);
}

function pauseGame() {
  if (state === "running") {
    state = "paused";
    clearInterval(timer);
    timer = null;
    pauseBtn.textContent = "Resume";
    statusEl.textContent = "Paused";
    titleEl.textContent = "Game paused";
    messageEl.textContent = "Ready when you are.";
    startBtn.textContent = "Resume Game";
    overlay.classList.remove("hidden");
    setProfileControlsDisabled(true);
  } else if (state === "paused") {
    startGame();
  }
}

function endGame() {
  state = "over";
  clearInterval(timer);
  timer = null;

  pauseBtn.disabled = true;
  statusEl.textContent = "Game over";
  setProfileControlsDisabled(false);
  titleEl.textContent = "Game over!";
  messageEl.textContent = `You scored ${score} point${score === 1 ? "" : "s"}. Try again!`;
  startBtn.textContent = "Play Again";
  overlay.classList.remove("hidden");
}

function tick() {
  direction = nextDirection;

  const head = {
    x: snake[0].x + direction.x,
    y: snake[0].y + direction.y
  };

  const eating = head.x === food.x && head.y === food.y;

  // If not eating, the tail moves away this turn.
  const bodyToCheck = eating ? snake : snake.slice(0, -1);

  const hitWall =
    head.x < 0 || head.x >= cells ||
    head.y < 0 || head.y >= cells;

  const hitSelf = bodyToCheck.some(
    part => part.x === head.x && part.y === head.y
  );

  if (hitWall || hitSelf) {
    endGame();
    return;
  }

  snake.unshift(head);

  if (eating) {
    score += 1;
    scoreEl.textContent = score;

    const activeProfile = profiles.find(profile => profile.id === activeProfileId);
    if (score > activeProfile.best) {
      best = score;
      activeProfile.best = score;
      bestEl.textContent = best;
      saveProfiles();
    }

    placeFood();
  } else {
    snake.pop();
  }

  draw();
}

function changeDirection(name) {
  if (!directions[name]) return;

  const candidate = directions[name];

  // Prevent reversing directly into the snake's own body.
  if (
    candidate.x + direction.x === 0 &&
    candidate.y + direction.y === 0
  ) {
    return;
  }

  nextDirection = candidate;

  if (state === "ready") {
    startGame();
  }
}

document.addEventListener("keydown", event => {
  const keys = {
    ArrowUp: "up",
    w: "up",
    W: "up",
    ArrowDown: "down",
    s: "down",
    S: "down",
    ArrowLeft: "left",
    a: "left",
    A: "left",
    ArrowRight: "right",
    d: "right",
    D: "right"
  };

  if (keys[event.key]) {
    event.preventDefault();
    changeDirection(keys[event.key]);
  } else if (event.code === "Space") {
    event.preventDefault();

    if (state === "running" || state === "paused") {
      pauseGame();
    } else if (state === "ready") {
      startGame();
    }
  }
});

document.querySelectorAll("[data-dir]").forEach(button => {
  button.addEventListener("click", () => {
    changeDirection(button.dataset.dir);
  });
});

startBtn.addEventListener("click", () => {
  if (state === "over") resetGame();
  startGame();
});

pauseBtn.addEventListener("click", pauseGame);

restartBtn.addEventListener("click", () => {
  clearInterval(timer);
  timer = null;
  resetGame();

  state = "ready";
  setProfileControlsDisabled(false);
  pauseBtn.disabled = true;
  pauseBtn.textContent = "Pause";
  titleEl.textContent = "Ready to play?";
  messageEl.textContent = "Grab the food and beat your high score.";
  startBtn.textContent = "Start Game";
  overlay.classList.remove("hidden");
});

resetGame();