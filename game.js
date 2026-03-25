const canvas = document.getElementById("arenaCanvas");
const ctx = canvas.getContext("2d");
const APP_CONFIG = window.__APP_CONFIG__ || {};

const startMenu = document.getElementById("startMenu");
const startButton = document.getElementById("startButton");
const resetButton = document.getElementById("resetButton");
const inviteButton = document.getElementById("inviteButton");
const connectingBanner = document.getElementById("connecting");
const connectionText = document.getElementById("connectionText");
const statusMessage = document.getElementById("statusMessage");
const playerHealthFill = document.getElementById("playerHealthFill");
const playerHealthText = document.getElementById("playerHealthText");
const waterFill = document.getElementById("waterFill");
const waterText = document.getElementById("waterText");
const opponentHealthFill = document.getElementById("opponentHealthFill");
const opponentHealthText = document.getElementById("opponentHealthText");
const roundText = document.getElementById("roundText");
const bitesText = document.getElementById("bitesText");

const dragonSprite = new Image();
dragonSprite.src = "dragon.png";
canvas.tabIndex = 0;

const GRID_SIZE = 30;
const WORLD_WIDTH = 4600;
const WORLD_HEIGHT = 3200;
const ARENA = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 1110 };
const WATER_ZONE = { x: ARENA.x - 250, y: ARENA.y + 250, radius: 175 };
const HEAL_ZONE = { x: ARENA.x + 300, y: ARENA.y - 230, radius: 145 };
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 270;
const BOOST_MULTIPLIER = 1.82;
const POSITION_LERP_SECONDS = 0.175;
const NORMAL_ACCEL = 16;
const BOOST_ACCEL = 18;
const NORMAL_DRAG = 8;
const BOOST_DRAG = 6;
const SPRITE_ROTATION = -Math.PI / 2;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;

const state = {
  phase: "menu",
  lastFrame: 0,
  pixelRatio: 1,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  pointer: {
    screenX: 0,
    screenY: 0,
    worldX: ARENA.x,
    worldY: ARENA.y,
    hasPointer: false,
    mouseDown: false,
    insideCanvas: false
  },
  input: {
    boost: false,
    secondary: false
  },
  camera: {
    x: ARENA.x,
    y: ARENA.y,
    zoom: 1.38,
    targetZoom: 1.38
  },
  player: null,
  opponent: null,
  round: {
    wins: 0,
    losses: 0,
    bites: 0,
    opponentBites: 0
  },
  network: {
    socket: null,
    url: "",
    desiredUrl: "",
    connected: false,
    remoteAuthority: false,
    reconnectTimer: null,
    lastTargetX: NaN,
    lastTargetY: NaN
  }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(current, target, sharpness, dt) {
  return current + (target - current) * (1 - Math.exp(-sharpness * dt));
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (!length) {
    return { x: 0, y: 0, length: 0 };
  }

  return {
    x: x / length,
    y: y / length,
    length
  };
}

function shortestAngleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

function createDragon(seed = {}) {
  const x = Number.isFinite(seed.x) ? seed.x : ARENA.x - ARENA.radius * 0.42;
  const y = Number.isFinite(seed.y) ? seed.y : ARENA.y;
  const angle = Number.isFinite(seed.angle) ? seed.angle : 0;
  const radius = Number.isFinite(seed.radius) ? seed.radius : PLAYER_RADIUS;

  return {
    name: seed.name || "Dragon",
    x,
    y,
    vx: Number.isFinite(seed.vx) ? seed.vx : 0,
    vy: Number.isFinite(seed.vy) ? seed.vy : 0,
    angle,
    radius,
    health: Number.isFinite(seed.health) ? seed.health : 100,
    maxHealth: Number.isFinite(seed.maxHealth) ? seed.maxHealth : 100,
    water: Number.isFinite(seed.water) ? seed.water : 100,
    maxWater: Number.isFinite(seed.maxWater) ? seed.maxWater : 100,
    baseSpeed: Number.isFinite(seed.baseSpeed) ? seed.baseSpeed : PLAYER_SPEED,
    boosting: false,
    boostVisual: Number.isFinite(seed.boostVisual) ? seed.boostVisual : 0,
    healVisual: Number.isFinite(seed.healVisual) ? seed.healVisual : 0,
    ox: x,
    oy: y,
    nx: x,
    ny: y,
    oAngle: angle,
    nAngle: angle,
    nRadius: radius,
    updateTime: performance.now()
  };
}

function syncRemoteDragon(current, snapshot, defaults = {}) {
  const mergedSnapshot = { ...defaults, ...snapshot };
  const now = performance.now();
  const dragon = current || createDragon(mergedSnapshot);
  const nextX = Number.isFinite(mergedSnapshot.x) ? mergedSnapshot.x : dragon.x;
  const nextY = Number.isFinite(mergedSnapshot.y) ? mergedSnapshot.y : dragon.y;
  const nextAngle = Number.isFinite(mergedSnapshot.angle) ? mergedSnapshot.angle : dragon.angle;
  const nextRadius = Number.isFinite(mergedSnapshot.radius) ? mergedSnapshot.radius : dragon.radius;

  dragon.ox = dragon.x;
  dragon.oy = dragon.y;
  dragon.nx = nextX;
  dragon.ny = nextY;
  dragon.oAngle = dragon.angle;
  dragon.nAngle = nextAngle;
  dragon.nRadius = nextRadius;
  dragon.updateTime = now;

  dragon.vx = Number.isFinite(mergedSnapshot.vx) ? mergedSnapshot.vx : dragon.vx;
  dragon.vy = Number.isFinite(mergedSnapshot.vy) ? mergedSnapshot.vy : dragon.vy;
  dragon.health = Number.isFinite(mergedSnapshot.health) ? mergedSnapshot.health : dragon.health;
  dragon.maxHealth = Number.isFinite(mergedSnapshot.maxHealth) ? mergedSnapshot.maxHealth : dragon.maxHealth;
  dragon.water = Number.isFinite(mergedSnapshot.water) ? mergedSnapshot.water : dragon.water;
  dragon.maxWater = Number.isFinite(mergedSnapshot.maxWater) ? mergedSnapshot.maxWater : dragon.maxWater;
  dragon.baseSpeed = Number.isFinite(mergedSnapshot.baseSpeed) ? mergedSnapshot.baseSpeed : dragon.baseSpeed;
  dragon.boosting = Boolean(mergedSnapshot.boosting);
  dragon.boostVisual = Number.isFinite(mergedSnapshot.boostVisual) ? mergedSnapshot.boostVisual : dragon.boostVisual;
  dragon.healVisual = Number.isFinite(mergedSnapshot.healVisual) ? mergedSnapshot.healVisual : dragon.healVisual;

  return dragon;
}

function updateRemoteDragon(dragon, dt) {
  if (!dragon) {
    return;
  }

  const progress = clamp((performance.now() - dragon.updateTime) / 1000 / POSITION_LERP_SECONDS, 0, 1);
  const previousX = dragon.x;
  const previousY = dragon.y;

  dragon.x = progress * (dragon.nx - dragon.ox) + dragon.ox;
  dragon.y = progress * (dragon.ny - dragon.oy) + dragon.oy;
  dragon.radius += (dragon.nRadius - dragon.radius) * 0.1;
  dragon.angle += shortestAngleDelta(dragon.angle, dragon.nAngle) * Math.min(0.1 * dt * 60, 1);
  dragon.vx = (dragon.x - previousX) / Math.max(dt, 0.0001);
  dragon.vy = (dragon.y - previousY) / Math.max(dt, 0.0001);
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function setConnection(message) {
  connectionText.textContent = message;
}

function showConnecting(show) {
  connectingBanner.classList.toggle("hidden", !show);
}

function normalizeServerUrl(url) {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return "";
  }

  if (trimmedUrl.startsWith("https://")) {
    return `wss://${trimmedUrl.slice("https://".length)}`;
  }

  if (trimmedUrl.startsWith("http://")) {
    return `ws://${trimmedUrl.slice("http://".length)}`;
  }

  return trimmedUrl;
}

function getConfiguredServerUrl() {
  const queryUrl = new URLSearchParams(window.location.search).get("server") || "";
  const configuredUrl = typeof APP_CONFIG.liveServerUrl === "string" ? APP_CONFIG.liveServerUrl : "";
  return normalizeServerUrl(queryUrl || configuredUrl);
}

function clearReconnectTimer() {
  if (state.network.reconnectTimer !== null) {
    window.clearTimeout(state.network.reconnectTimer);
    state.network.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!state.network.desiredUrl || state.network.reconnectTimer !== null || socketIsOpen()) {
    return;
  }

  state.network.reconnectTimer = window.setTimeout(() => {
    state.network.reconnectTimer = null;
    connectToServer(state.network.desiredUrl, true);
  }, 2500);
}

function syncHud() {
  const player = state.player;
  const opponent = state.opponent;

  const healthRatio = player ? clamp(player.health / player.maxHealth, 0, 1) : 1;
  const waterRatio = player ? clamp(player.water / player.maxWater, 0, 1) : 1;
  const opponentRatio = opponent ? clamp(opponent.health / opponent.maxHealth, 0, 1) : 0;

  playerHealthFill.style.transform = `scaleX(${healthRatio})`;
  waterFill.style.transform = `scaleX(${waterRatio})`;
  opponentHealthFill.style.transform = `scaleX(${opponentRatio})`;

  playerHealthText.textContent = player
    ? `${Math.round(player.health)} / ${player.maxHealth}`
    : "100 / 100";

  waterText.textContent = player
    ? `${Math.round(player.water)} / ${player.maxWater}`
    : "100 / 100";

  opponentHealthText.textContent = opponent
    ? `${Math.round(opponent.health)} / ${opponent.maxHealth}`
    : "Waiting";

  roundText.textContent = `Wins ${state.round.wins} - ${state.round.losses}`;
  bitesText.textContent = `Bites ${state.round.bites} - ${state.round.opponentBites}`;
}

function resizeCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  state.pixelRatio = pixelRatio;
  state.viewport.width = window.innerWidth;
  state.viewport.height = window.innerHeight;

  canvas.width = Math.round(state.viewport.width * pixelRatio);
  canvas.height = Math.round(state.viewport.height * pixelRatio);
  canvas.style.width = `${state.viewport.width}px`;
  canvas.style.height = `${state.viewport.height}px`;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  updatePointerWorld();
  sendResizePacket();
}

function screenToWorld(screenX, screenY) {
  const halfWidth = state.viewport.width / 2;
  const halfHeight = state.viewport.height / 2;

  return {
    x: (screenX - (halfWidth - state.camera.x * state.camera.zoom)) / state.camera.zoom,
    y: (screenY - (halfHeight - state.camera.y * state.camera.zoom)) / state.camera.zoom
  };
}

function worldToScreen(worldX, worldY) {
  return {
    x: worldX * state.camera.zoom + (state.viewport.width / 2 - state.camera.x * state.camera.zoom),
    y: worldY * state.camera.zoom + (state.viewport.height / 2 - state.camera.y * state.camera.zoom)
  };
}

function updatePointerWorld() {
  const world = screenToWorld(state.pointer.screenX, state.pointer.screenY);
  state.pointer.worldX = world.x;
  state.pointer.worldY = world.y;
}

function updatePointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  state.pointer.screenX = event.clientX - rect.left;
  state.pointer.screenY = event.clientY - rect.top;
  state.pointer.hasPointer = true;
  state.pointer.insideCanvas = true;
  updatePointerWorld();
}

function distanceToZone(entity, zone) {
  return Math.hypot(entity.x - zone.x, entity.y - zone.y);
}

function clampToArena(dragon) {
  const dx = dragon.x - ARENA.x;
  const dy = dragon.y - ARENA.y;
  const distance = Math.hypot(dx, dy) || 1;
  const limit = ARENA.radius - dragon.radius - 8;

  if (distance > limit) {
    dragon.x = ARENA.x + (dx / distance) * limit;
    dragon.y = ARENA.y + (dy / distance) * limit;
    dragon.vx *= 0.28;
    dragon.vy *= 0.28;
  }

  dragon.x = clamp(dragon.x, dragon.radius, WORLD_WIDTH - dragon.radius);
  dragon.y = clamp(dragon.y, dragon.radius, WORLD_HEIGHT - dragon.radius);
}

function spawnDragon() {
  state.player = createDragon();
  state.opponent = null;
  state.phase = "running";
  state.pointer.hasPointer = false;
  state.input.boost = false;
  state.input.secondary = false;
  state.network.lastTargetX = NaN;
  state.network.lastTargetY = NaN;

  state.round.bites = 0;
  state.round.opponentBites = 0;

  state.camera.x = state.player.x;
  state.camera.y = state.player.y;
  state.camera.zoom = 1.38;
  state.camera.targetZoom = 1.38;

  setStatus("Dragon spawned. Mouse to move, left click or Space to boost, Q to send 1v1.");
  syncHud();
}

function resetArena() {
  if (state.network.connected && state.network.remoteAuthority) {
    setStatus("Live arena resets on the server. Press Q to queue again if you need a new 1v1.");
    return;
  }

  spawnDragon();
  if (state.network.connected) {
    setStatus("Arena reset. Water and health restored.");
  }
}

function updateLocalDragon(dt) {
  if (!state.player) {
    return;
  }

  const dragon = state.player;
  const previousX = dragon.x;
  const previousY = dragon.y;
  const targetX = state.pointer.hasPointer
    ? state.pointer.worldX
    : dragon.x + Math.cos(dragon.angle) * 160;
  const targetY = state.pointer.hasPointer
    ? state.pointer.worldY
    : dragon.y + Math.sin(dragon.angle) * 160;

  const direction = normalize(targetX - dragon.x, targetY - dragon.y);
  const distance = direction.length;
  const wantsBoost = state.input.boost && dragon.water > 0.5;
  const maxSpeed = dragon.baseSpeed * (wantsBoost ? BOOST_MULTIPLIER : 1);
  const targetSpeed = Math.min(maxSpeed, distance / POSITION_LERP_SECONDS);
  const accel = wantsBoost ? BOOST_ACCEL : NORMAL_ACCEL;
  const drag = wantsBoost ? BOOST_DRAG : NORMAL_DRAG;
  const easing = 1 - Math.exp(-accel * dt);

  dragon.vx += (direction.x * targetSpeed - dragon.vx) * easing;
  dragon.vy += (direction.y * targetSpeed - dragon.vy) * easing;

  if (distance < 0.001) {
    dragon.vx *= Math.exp(-drag * dt);
    dragon.vy *= Math.exp(-drag * dt);
  }

  const maxStep = maxSpeed * dt;
  const proposedStep = Math.hypot(dragon.vx * dt, dragon.vy * dt);
  const stepScale = proposedStep > maxStep && proposedStep > 0 ? maxStep / proposedStep : 1;

  dragon.x += dragon.vx * dt * stepScale;
  dragon.y += dragon.vy * dt * stepScale;
  dragon.vx = (dragon.x - previousX) / Math.max(dt, 0.0001);
  dragon.vy = (dragon.y - previousY) / Math.max(dt, 0.0001);

  const movement = Math.hypot(dragon.vx, dragon.vy);
  if (movement > 5) {
    dragon.angle = Math.atan2(dragon.vy, dragon.vx);
  }

  const inWater = distanceToZone(dragon, WATER_ZONE) <= WATER_ZONE.radius - dragon.radius * 0.15;
  const inHeal = distanceToZone(dragon, HEAL_ZONE) <= HEAL_ZONE.radius - dragon.radius * 0.1;

  if (wantsBoost && distance > 0.001) {
    dragon.water = Math.max(0, dragon.water - 24 * dt);
  }

  if (inWater) {
    dragon.water = Math.min(dragon.maxWater, dragon.water + 36 * dt);
  }

  if (inHeal) {
    dragon.health = Math.min(dragon.maxHealth, dragon.health + 13 * dt);
  }

  dragon.boosting = wantsBoost && distance > 0.001;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  dragon.healVisual = approach(dragon.healVisual, inHeal ? 1 : 0, 9, dt);

  clampToArena(dragon);
}

function updateCamera(dt) {
  if (!state.player) {
    state.camera.x = approach(state.camera.x, ARENA.x, 3.5, dt);
    state.camera.y = approach(state.camera.y, ARENA.y, 3.5, dt);
    state.camera.zoom = approach(state.camera.zoom, state.camera.targetZoom, 3.5, dt);
    return;
  }

  state.camera.x = approach(state.camera.x, state.player.x, 8, dt);
  state.camera.y = approach(state.camera.y, state.player.y, 8, dt);
  state.camera.targetZoom = state.player.boosting ? 1.27 : 1.38;
  state.camera.zoom = approach(state.camera.zoom, state.camera.targetZoom, 4.4, dt);
}

function beginWorldTransform() {
  const halfWidth = state.viewport.width / 2;
  const halfHeight = state.viewport.height / 2;

  ctx.save();
  ctx.translate(
    halfWidth * (1 - state.camera.zoom) + (halfWidth - state.camera.x) * state.camera.zoom,
    halfHeight * (1 - state.camera.zoom) + (halfHeight - state.camera.y) * state.camera.zoom
  );
  ctx.scale(state.camera.zoom, state.camera.zoom);
}

function drawWorld() {
  ctx.fillStyle = "#3fba54";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.strokeStyle = "rgba(17, 66, 17, 0.38)";
  ctx.lineWidth = 12;
  ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
}

function drawGrid() {
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(state.viewport.width, state.viewport.height);
  const minX = clamp(topLeft.x, 0, WORLD_WIDTH);
  const minY = clamp(topLeft.y, 0, WORLD_HEIGHT);
  const maxX = clamp(bottomRight.x, 0, WORLD_WIDTH);
  const maxY = clamp(bottomRight.y, 0, WORLD_HEIGHT);

  ctx.save();
  ctx.strokeStyle = "black";
  ctx.globalAlpha = 0.055;
  ctx.lineWidth = 1;

  const width = maxX - minX;
  const height = maxY - minY;

  for (let x = -0.5 + minX + (width - minX) % GRID_SIZE; x <= minX + width; x += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x, minY + height);
    ctx.stroke();
  }

  for (let y = -0.5 + minY + (height - minY) % GRID_SIZE; y <= minY + height; y += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(minX + width, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawArena() {
  const arenaGradient = ctx.createRadialGradient(
    ARENA.x,
    ARENA.y,
    ARENA.radius * 0.25,
    ARENA.x,
    ARENA.y,
    ARENA.radius
  );
  arenaGradient.addColorStop(0, "rgba(98, 183, 75, 0.18)");
  arenaGradient.addColorStop(1, "rgba(29, 87, 20, 0.52)");

  ctx.fillStyle = arenaGradient;
  ctx.beginPath();
  ctx.arc(ARENA.x, ARENA.y, ARENA.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(223, 255, 198, 0.2)";
  ctx.beginPath();
  ctx.arc(ARENA.x, ARENA.y, ARENA.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  for (const ring of [0.3, 0.56, 0.82]) {
    ctx.beginPath();
    ctx.arc(ARENA.x, ARENA.y, ARENA.radius * ring, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawZone(zone, innerColor, outerColor, label) {
  const gradient = ctx.createRadialGradient(zone.x, zone.y, zone.radius * 0.22, zone.x, zone.y, zone.radius);
  gradient.addColorStop(0, innerColor);
  gradient.addColorStop(1, outerColor);

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.58)";
  ctx.font = "700 20px Segoe UI";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, zone.x, zone.y);
}

function drawDragon(dragon, glowColor, bodyAlpha = 1) {
  if (!dragon) {
    return;
  }

  const size = dragon.radius * 2.65 * (1 + dragon.boostVisual * 0.08);
  const lunge = dragon.boostVisual * 16;

  ctx.save();
  ctx.translate(
    dragon.x + Math.cos(dragon.angle) * lunge,
    dragon.y + Math.sin(dragon.angle) * lunge
  );
  ctx.rotate(dragon.angle + SPRITE_ROTATION);

  if (dragon.boostVisual > 0.02) {
    ctx.globalAlpha = 0.16 + dragon.boostVisual * 0.18;
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, size * 0.04);
    ctx.lineTo(-size * 0.4, size * 0.6);
    ctx.lineTo(size * 0.14, size * 0.12);
    ctx.fill();
  }

  ctx.globalAlpha = bodyAlpha;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 24 + dragon.boostVisual * 14;

  if (dragonSprite.complete && dragonSprite.naturalWidth > 0) {
    ctx.drawImage(dragonSprite, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#2ce0ba";
    ctx.beginPath();
    ctx.arc(0, 0, dragon.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (dragon.healVisual > 0.02) {
    ctx.globalAlpha = dragon.healVisual * 0.45;
    ctx.strokeStyle = "#a6ffe3";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, dragon.radius + 8 + dragon.healVisual * 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPointer() {
  if (!state.pointer.hasPointer || !state.player) {
    return;
  }

  const cursor = worldToScreen(state.pointer.worldX, state.pointer.worldY);

  ctx.save();
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  ctx.strokeStyle = "rgba(196, 255, 245, 0.5)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cursor.x - 18, cursor.y);
  ctx.lineTo(cursor.x + 18, cursor.y);
  ctx.moveTo(cursor.x, cursor.y - 18);
  ctx.lineTo(cursor.x, cursor.y + 18);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  ctx.clearRect(0, 0, state.viewport.width, state.viewport.height);

  beginWorldTransform();
  drawWorld();
  drawGrid();
  drawArena();
  drawZone(WATER_ZONE, "rgba(90, 203, 255, 0.55)", "rgba(18, 77, 108, 0.2)", "Water");
  drawZone(HEAL_ZONE, "rgba(135, 255, 219, 0.38)", "rgba(30, 110, 82, 0.16)", "Heal");
  drawDragon(state.opponent, "#ff9a6b", 0.9);
  drawDragon(state.player, "#65fff0", 1);
  ctx.restore();

  drawPointer();
}

function update(dt) {
  if (state.phase === "running" && (!state.network.connected || !state.network.remoteAuthority)) {
    updateLocalDragon(dt);
  }

  if (state.network.connected && state.network.remoteAuthority) {
    updateRemoteDragon(state.player, dt);
    updateRemoteDragon(state.opponent, dt);
  }

  updateCamera(dt);
  syncHud();
}

function frame(now) {
  if (!state.lastFrame) {
    state.lastFrame = now;
  }

  const dt = clamp((now - state.lastFrame) / 1000, 0, 0.05);
  state.lastFrame = now;

  update(dt);
  draw();
  requestAnimationFrame(frame);
}

function socketIsOpen() {
  return state.network.socket && state.network.socket.readyState === WebSocket.OPEN;
}

function sendPacket(byteLength, writer) {
  if (!socketIsOpen()) {
    return;
  }

  const view = new DataView(new ArrayBuffer(byteLength));
  writer(view);
  state.network.socket.send(view.buffer);
}

function sendBooleanPacket(code, value) {
  sendPacket(2, (view) => {
    view.setUint8(0, code);
    view.setUint8(1, value ? 1 : 0);
  });
}

function sendResizePacket() {
  sendPacket(7, (view) => {
    view.setUint8(0, PACKET_RESIZE);
    view.setUint16(1, Math.round(state.viewport.width), false);
    view.setUint16(3, Math.round(state.viewport.height), false);
    view.setUint16(5, Math.round(window.innerWidth), false);
  });
}

function sendPointerPacket() {
  if (!socketIsOpen() || state.phase !== "running" || !state.pointer.hasPointer) {
    return;
  }

  if (
    Number.isFinite(state.network.lastTargetX) &&
    Math.abs(state.network.lastTargetX - state.pointer.worldX) <= 0.1 &&
    Math.abs(state.network.lastTargetY - state.pointer.worldY) <= 0.1
  ) {
    return;
  }

  state.network.lastTargetX = state.pointer.worldX;
  state.network.lastTargetY = state.pointer.worldY;

  sendPacket(5, (view) => {
    view.setUint8(0, PACKET_POINTER);
    view.setInt16(1, Math.round(clamp(state.pointer.worldX, -32768, 32767)), false);
    view.setInt16(3, Math.round(clamp(state.pointer.worldY, -32768, 32767)), false);
  });
}

function sendInvitePacket() {
  if (!socketIsOpen()) {
    setStatus(
      state.network.desiredUrl
        ? "The live server is still waking up. Keep the page open and it will reconnect."
        : "Practice mode is active. Real 1v1 invites need a live WebSocket server."
    );
    return;
  }

  sendPacket(2, (view) => {
    view.setUint8(0, PACKET_INVITE_1V1);
    view.setUint8(1, 0);
  });

  setStatus("1v1 invite sent.");
}

function releaseAllActions() {
  if (state.input.boost) {
    state.input.boost = false;
    sendBooleanPacket(PACKET_BOOST, false);
  }

  if (state.input.secondary) {
    state.input.secondary = false;
    sendBooleanPacket(PACKET_SECONDARY, false);
  }
}

function setBoost(active) {
  if (state.input.boost === active) {
    return;
  }

  state.input.boost = active;
  sendBooleanPacket(PACKET_BOOST, active);
}

function setSecondary(active) {
  if (state.input.secondary === active) {
    return;
  }

  state.input.secondary = active;
  sendBooleanPacket(PACKET_SECONDARY, active);
}

function connectToServer(url, isReconnect = false) {
  const trimmedUrl = normalizeServerUrl(url);
  state.network.desiredUrl = trimmedUrl;
  clearReconnectTimer();

  if (state.network.socket) {
    state.network.socket.close();
    state.network.socket = null;
  }

  state.network.connected = false;
  state.network.remoteAuthority = false;
  state.network.url = trimmedUrl;

  if (!trimmedUrl) {
    setConnection("Practice only");
    showConnecting(false);
    return;
  }

  try {
    showConnecting(true);
    setConnection(isReconnect ? "Reconnecting" : "Connecting");
    setStatus(isReconnect ? "Trying the live arena again..." : "Connecting to the live arena...");

    const socket = new WebSocket(trimmedUrl);
    socket.binaryType = "arraybuffer";
    state.network.socket = socket;

    socket.addEventListener("open", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.connected = true;
      setConnection("Connected");
      showConnecting(false);
      sendResizePacket();
      setStatus("Connected. Waiting for another dragon...");
    });

    socket.addEventListener("close", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.socket = null;
      state.network.connected = false;
      state.network.remoteAuthority = false;
      setConnection(trimmedUrl ? "Disconnected" : "Practice only");
      showConnecting(false);
      if (state.network.desiredUrl) {
        setStatus("Live arena disconnected. Reconnecting...");
        scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.connected = false;
      state.network.remoteAuthority = false;
      setConnection("Connection error");
      showConnecting(false);
      setStatus("Could not reach the live arena yet. It may still be waking up.");
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const message = JSON.parse(event.data);
        applyServerMessage(message);
      } catch (_error) {
        // Ignore text frames that are not JSON. The original client primarily
        // speaks binary, and this lightweight practice client only mirrors the
        // outgoing packet flow here.
      }
    });
  } catch (_error) {
    state.network.connected = false;
    state.network.remoteAuthority = false;
    setConnection("Connection error");
    showConnecting(false);
    setStatus("Could not reach the live arena yet. It may still be waking up.");
    scheduleReconnect();
  }
}

function applyServerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (typeof message.status === "string") {
    setStatus(message.status);
  }

  if (message.round && typeof message.round === "object") {
    if (Number.isFinite(message.round.wins)) {
      state.round.wins = message.round.wins;
    }
    if (Number.isFinite(message.round.losses)) {
      state.round.losses = message.round.losses;
    }
    if (Number.isFinite(message.round.bites)) {
      state.round.bites = message.round.bites;
    }
    if (Number.isFinite(message.round.opponentBites)) {
      state.round.opponentBites = message.round.opponentBites;
    }
  }

  if (message.player && typeof message.player === "object") {
    state.network.remoteAuthority = true;
    state.player = syncRemoteDragon(state.player, message.player);
  }

  if (message.opponent && typeof message.opponent === "object") {
    state.opponent = syncRemoteDragon(state.opponent, message.opponent, {
      x: ARENA.x + ARENA.radius * 0.42,
      y: ARENA.y,
      angle: Math.PI
    });
  } else if (message.opponent === null) {
    state.opponent = null;
  }
}

function startPractice() {
  if (state.phase === "running" && startMenu.classList.contains("hidden")) {
    return;
  }

  const url = getConfiguredServerUrl();
  connectToServer(url);
  spawnDragon();
  if (url) {
    setConnection("Connecting");
    setStatus("Connecting to the live arena...");
  }
  startMenu.classList.add("hidden");
  canvas.focus();
}

function hydrateConnectionState() {
  if (getConfiguredServerUrl()) {
    setConnection("Live ready");
    return;
  }

  setConnection("Practice only");
}

window.addEventListener("resize", resizeCanvas);

window.addEventListener("mousemove", (event) => {
  updatePointerFromEvent(event);
});

canvas.addEventListener("mouseenter", (event) => {
  updatePointerFromEvent(event);
});

canvas.addEventListener("mouseleave", () => {
  state.pointer.insideCanvas = false;
  if (!state.pointer.mouseDown) {
    state.pointer.hasPointer = false;
  }
});

canvas.addEventListener("mousedown", (event) => {
  updatePointerFromEvent(event);
  state.pointer.mouseDown = true;

  if (event.button === 0) {
    setBoost(true);
  } else if (event.button === 2) {
    setSecondary(true);
  }
});

window.addEventListener("mouseup", (event) => {
  state.pointer.mouseDown = false;

  if (event.button === 0) {
    setBoost(false);
  } else if (event.button === 2) {
    setSecondary(false);
  }
});

window.addEventListener("blur", () => {
  state.pointer.mouseDown = false;
  state.pointer.hasPointer = false;
  releaseAllActions();
});

document.addEventListener("keydown", (event) => {
  if (state.phase === "menu" && (event.code === "Enter" || event.code === "NumpadEnter")) {
    event.preventDefault();
    startPractice();
    return;
  }

  if (event.repeat) {
    return;
  }

  switch (event.code) {
    case "Space":
      event.preventDefault();
      setBoost(true);
      break;
    case "KeyW":
      event.preventDefault();
      setSecondary(true);
      break;
    case "KeyQ":
      event.preventDefault();
      sendInvitePacket();
      break;
    default:
      break;
  }
});

document.addEventListener("keyup", (event) => {
  switch (event.code) {
    case "Space":
      event.preventDefault();
      setBoost(false);
      break;
    case "KeyW":
      event.preventDefault();
      setSecondary(false);
      break;
    default:
      break;
  }
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

startButton.addEventListener("click", startPractice);
startButton.addEventListener("pointerup", (event) => {
  event.preventDefault();
  startPractice();
});
resetButton.addEventListener("click", resetArena);
inviteButton.addEventListener("click", sendInvitePacket);

setInterval(sendPointerPacket, 10);

hydrateConnectionState();
resizeCanvas();
syncHud();
requestAnimationFrame(frame);
