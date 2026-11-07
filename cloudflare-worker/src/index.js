import { DurableObject } from "cloudflare:workers";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUITS = ["espadas", "bastos", "oros", "copas"];
const RANKS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
function randomHex(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}
function safeName(value, fallback) {
  const name = String(value || "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 18);
  return name || fallback;
}
function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => {
    const strength = rank === 1
      ? (suit === "espadas" ? 14 : suit === "bastos" ? 13 : 8)
      : rank === 7
        ? (suit === "espadas" ? 12 : suit === "oros" ? 11 : 4)
        : rank === 3 ? 10 : rank === 2 ? 9 : rank === 12 ? 7 : rank === 11 ? 6 : rank === 10 ? 5 : rank === 6 ? 3 : rank === 5 ? 2 : 1;
    return { id: `${suit}-${rank}`, suit, rank, strength, envido: rank <= 7 ? rank : 0 };
  }));
}
const DECK_BASE = makeDeck();
function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function hasFlor(hand) {
  return Array.isArray(hand) && hand.length === 3 && hand.every((card) => card.suit === hand[0].suit);
}
function florPoints(hand) {
  return hasFlor(hand) ? 20 + hand.reduce((sum, card) => sum + card.envido, 0) : 0;
}
function envidoPoints(hand) {
  let best = 0;
  for (const suit of SUITS) {
    const values = hand.filter((card) => card.suit === suit).map((card) => card.envido).sort((a, b) => b - a);
    if (values.length >= 2) best = Math.max(best, 20 + values[0] + values[1]);
    else if (values.length === 1) best = Math.max(best, values[0]);
  }
  return best;
}
function offerValue(type, game) {
  return type === "envido" ? 2 : type === "real" ? 3 : Math.max(1, game.targetPoints - Math.max(...game.scores));
}
function faltaValueForWinner(game, winner, committed = 0) {
  const half = game.targetPoints / 2;
  const [a, b] = game.scores;
  if (a < half && b < half) return Math.max(1, game.targetPoints - game.scores[winner] - committed);
  return Math.max(1, game.targetPoints - Math.max(a, b) - committed);
}
function envidoRaiseOptions(type, chain = 1) {
  if (type === "envido") return chain === 1 ? ["envido", "real", "falta"] : ["real", "falta"];
  if (type === "real") return ["falta"];
  return [];
}
function trickWinner(cards) {
  const [a, b] = cards;
  if (a.card.strength > b.card.strength) return a.player;
  if (b.card.strength > a.card.strength) return b.player;
  return null;
}
function handWinner(tricks, mano) {
  if (tricks.length < 2) return null;
  const first = tricks[0].winner;
  const second = tricks[1].winner;
  if (first === null) {
    if (second !== null) return second;
    return mano;
  }
  if (second === first || second === null) return first;
  if (tricks.length < 3) return null;
  return tricks[2].winner === null ? first : tricks[2].winner;
}

function newGame(targetPoints, withFlor) {
  return {
    scores: [0, 0], mano: Math.random() < 0.5 ? 0 : 1, handNo: 0,
    hands: [[], []], deck: [], turn: 0, lead: 0,
    currentTrick: [], tricks: [], publicPlayed: [],
    trucoLevel: 0, escalateBy: null, trucoPending: null, envidoPending: null,
    florPending: null, heldTruco: null, envidoDone: false, florDone: !withFlor,
    withFlor, targetPoints, dealing: false, handOver: false, gameOver: false,
    resolvingTrick: false, foldedBy: null, foldPoints: 0,
    handWinner: null, handScoreAtStart: [0, 0], envidoReveal: null,
    log: "Nueva partida: ¡suerte!", deadlines: { dealAt: 0, trickAt: 0, expireAt: Date.now() + 12 * 60 * 60 * 1000 },
  };
}
function startHand(game) {
  game.handNo += 1;
  game.handScoreAtStart = game.scores.slice();
  game.deck = shuffle(DECK_BASE);
  game.hands = [[], []];
  for (let i = 0; i < 6; i++) game.hands[i % 2].push(game.deck.pop());
  game.turn = game.mano;
  game.lead = game.mano;
  game.currentTrick = [];
  game.tricks = [];
  game.publicPlayed = [];
  game.trucoLevel = 0;
  game.escalateBy = null;
  game.trucoPending = null;
  game.envidoPending = null;
  game.florPending = null;
  game.heldTruco = null;
  game.envidoDone = false;
  game.florDone = !game.withFlor || (!hasFlor(game.hands[0]) && !hasFlor(game.hands[1]));
  game.dealing = true;
  game.handOver = false;
  game.gameOver = false;
  game.resolvingTrick = false;
  game.foldedBy = null;
  game.foldPoints = 0;
  game.handWinner = null;
  game.envidoReveal = null;
  game.log = `Mano ${game.handNo}: ${game.mano === 0 ? "Jugador 1" : "Jugador 2"} es mano.`;
  game.deadlines.dealAt = Date.now() + 4550;
  game.deadlines.trickAt = 0;
}

const ACCOUNT_STATS_FIELDS = [
  "matchesPlayed", "matchesWon", "matchesLost", "handsPlayed", "handsWon", "handsLost",
  "pointsFor", "pointsAgainst", "trucoCallsYou", "trucoCallsAI", "envidoCallsYou", "envidoCallsAI",
  "currentStreak", "bestWinStreak",
];
function bytesToHex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(value) { return new Uint8Array((String(value).match(/.{2}/g) || []).map((pair) => parseInt(pair, 16))); }
async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function passwordDigest(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 120000, hash: "SHA-256" }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function safeUsername(value) {
  const username = String(value || "").trim();
  return /^[A-Za-z0-9_]{3,18}$/.test(username) ? username : null;
}
function safeAvatar(value) {
  if (value == null || value === "") return null;
  const avatar = String(value);
  if (avatar.length > 120000 || !/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw new Error("La foto debe ser JPG, PNG o WebP y pesar menos de 90 KB después de optimizarla.");
  return avatar;
}
function safeStats(value) {
  let input = value;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
  const result = {};
  for (const key of ACCOUNT_STATS_FIELDS) {
    const number = Number(input?.[key]);
    result[key] = Number.isFinite(number) ? Math.max(0, Math.min(1000000000, Math.floor(number))) : 0;
  }
  return result;
}
function publicProfile(row) {
  return { id: row.id, username: row.username, avatar: row.avatar_data || null, stats: safeStats(row.progress_json) };
}
async function createAccountSession(env, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expires = now + 60 * 24 * 60 * 60 * 1000;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, userId, now, expires).run();
  return token;
}
async function authenticateAccount(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    "SELECT u.id, u.username, u.avatar_data, u.progress_json FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1"
  ).bind(tokenHash, Date.now()).first();
}
async function handleAccount(request, env, url, cors) {
  if (!env.DB) return json({ error: "Falta configurar la base D1 (binding DB) en Cloudflare." }, 503, cors);
  try {
    if (url.pathname === "/api/account/register" && request.method === "POST") {
      const body = await request.json();
      const username = safeUsername(body.username);
      const password = String(body.password || "");
      if (!username) return json({ error: "El usuario debe tener entre 3 y 18 caracteres: letras, números o _." }, 400, cors);
      if (password.length < 8 || password.length > 72) return json({ error: "La contraseña debe tener entre 8 y 72 caracteres." }, 400, cors);
      let avatar;
      try { avatar = safeAvatar(body.avatar); } catch (error) { return json({ error: error.message }, 400, cors); }
      const salt = randomHex(16);
      const digest = await passwordDigest(password, salt);
      const id = randomHex(16);
      const now = Date.now();
      const stats = JSON.stringify(safeStats(body.stats));
      try {
        await env.DB.prepare("INSERT INTO users (id, username, password_salt, password_hash, avatar_data, progress_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, username, salt, digest, avatar, stats, now, now).run();
      } catch (error) {
        if (/unique|constraint/i.test(String(error))) return json({ error: "Ese nombre de usuario ya está registrado." }, 409, cors);
        throw error;
      }
      const token = await createAccountSession(env, id);
      return json({ token, profile: { id, username, avatar, stats: safeStats(stats) } }, 201, cors);
    }
    if (url.pathname === "/api/account/login" && request.method === "POST") {
      const body = await request.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const row = await env.DB.prepare("SELECT id, username, password_salt, password_hash, avatar_data, progress_json FROM users WHERE username=? COLLATE NOCASE LIMIT 1").bind(username).first();
      if (!row || password.length > 72 || await passwordDigest(password, row.password_salt) !== row.password_hash) {
        return json({ error: "Usuario o contraseña incorrectos." }, 401, cors);
      }
      const token = await createAccountSession(env, row.id);
      return json({ token, profile: publicProfile(row) }, 200, cors);
    }
    if (url.pathname === "/api/account/me" && request.method === "GET") {
      const user = await authenticateAccount(request, env);
      if (!user) return json({ error: "La sesión venció. Iniciá sesión nuevamente." }, 401, cors);
      return json({ profile: publicProfile(user) }, 200, cors);
    }
    if (url.pathname === "/api/account/progress" && request.method === "PUT") {
      const user = await authenticateAccount(request, env);
      if (!user) return json({ error: "La sesión venció. Iniciá sesión nuevamente." }, 401, cors);
      const body = await request.json();
      let avatar = null;
      try { if (Object.prototype.hasOwnProperty.call(body, "avatar")) avatar = safeAvatar(body.avatar); }
      catch (error) { return json({ error: error.message }, 400, cors); }
      await env.DB.prepare("UPDATE users SET progress_json=?, avatar_data=COALESCE(?, avatar_data), updated_at=? WHERE id=?")
        .bind(JSON.stringify(safeStats(body.stats)), avatar, Date.now(), user.id).run();
      return json({ ok: true }, 200, cors);
    }
    if (url.pathname === "/api/account/logout" && request.method === "POST") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256Hex(token)).run();
      return json({ ok: true }, 200, cors);
    }
    return json({ error: "Ruta de cuenta desconocida." }, 404, cors);
  } catch (error) {
    console.error("Account API error", error);
    return json({ error: "No se pudo completar la operación de cuenta. Revisá la configuración D1." }, 500, cors);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://jxdxv.github.io")
      .split(",").map((item) => item.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) return json({ error: "Origen no permitido." }, 403);
    const cors = { ...CORS_HEADERS, ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname.startsWith("/api/account/")) return handleAccount(request, env, url, cors);

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      if (!env.DB) return json({ error: "Falta configurar la base D1 (binding DB) en Cloudflare." }, 503, cors);
      try {
        const cutoff = Date.now() - 8 * 60 * 60 * 1000;
        const result = await env.DB.prepare(
          "SELECT code, creator_name AS playerName, player_count AS playerCount, target_points AS targetPoints, with_flor AS withFlor, created_at AS createdAt FROM rooms WHERE status='waiting' AND player_count<2 AND created_at>? ORDER BY created_at DESC LIMIT 40"
        ).bind(cutoff).all();
        return json({ rooms: result.results || [] }, 200, cors);
      } catch (error) {
        console.error("Room directory error", error);
        return json({ error: "No se pudo cargar la lista de salas. Revisá la migración D1." }, 500, cors);
      }
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400, cors); }
      const targetPoints = [15, 30, 40].includes(Number(body.targetPoints)) ? Number(body.targetPoints) : 30;
      const withFlor = Boolean(body.withFlor);
      const playerName = safeName(body.playerName, "Jugador 1");
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const id = env.TRUCO_ROOMS.idFromName(`room:${code}`);
        const stub = env.TRUCO_ROOMS.get(id);
        const response = await stub.fetch("https://room.internal/create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, targetPoints, withFlor, playerName }),
        });
        if (response.status === 201) {
          const data = await response.json();
          if (env.DB) await env.DB.prepare("INSERT OR REPLACE INTO rooms (code, created_at, updated_at, creator_name, player_count, target_points, with_flor, status) VALUES (?, ?, ?, ?, 1, ?, ?, 'waiting')")
            .bind(code, Date.now(), Date.now(), playerName, targetPoints, withFlor ? 1 : 0).run();
          return json({ ...data, code, wsPath: `/api/rooms/${code}/ws` }, 201, cors);
        }
      }
      return json({ error: "No se pudo reservar un código. Intentá nuevamente." }, 503, cors);
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/i);
    if (joinMatch && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400, cors); }
      const code = joinMatch[1].toUpperCase();
      const stub = env.TRUCO_ROOMS.get(env.TRUCO_ROOMS.idFromName(`room:${code}`));
      const response = await stub.fetch("https://room.internal/join", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: safeName(body.playerName, "Jugador 2") }),
      });
      if (response.ok && env.DB) await env.DB.prepare("UPDATE rooms SET player_count=2, updated_at=? WHERE code=?").bind(Date.now(), code).run();
      return new Response(response.body, { status: response.status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
    }

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/ws$/i);
    if (wsMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const code = wsMatch[1].toUpperCase();
      const stub = env.TRUCO_ROOMS.get(env.TRUCO_ROOMS.idFromName(`room:${code}`));
      const internalUrl = new URL(request.url);
      internalUrl.hostname = "room.internal";
      internalUrl.pathname = "/ws";
      return stub.fetch(new Request(internalUrl.toString(), request));
    }

    return json({ ok: true, service: "truco-argentino-multiplayer", endpoints: ["GET /api/rooms", "POST /api/rooms", "POST /api/rooms/:code/join", "GET /api/rooms/:code/ws", "POST /api/account/register", "POST /api/account/login", "GET /api/account/me", "PUT /api/account/progress"] }, 200, cors);
  },
};

export class TrucoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room") || null;
      if (this.room) this.rebuildConnections();
    });
  }

  rebuildConnections() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && this.room?.players?.[att.seat]) this.room.players[att.seat].connected = true;
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") return this.createRoom(request);
    if (url.pathname === "/join" && request.method === "POST") return this.joinRoom(request);
    if (url.pathname === "/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.connect(request, url);
    return json({ error: "Ruta interna desconocida." }, 404);
  }

  async persist() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  async syncDirectoryStatus(status) {
    if (!this.env.DB || !this.room?.code) return;
    try {
      await this.env.DB.prepare("UPDATE rooms SET status=?, updated_at=? WHERE code=?")
        .bind(status, Date.now(), this.room.code).run();
    } catch (error) { console.warn("No se pudo actualizar el directorio de salas", error); }
  }

  async createRoom(request) {
    if (this.room) return json({ error: "Código ocupado." }, 409);
    const body = await request.json();
    const hostToken = randomHex(24);
    this.room = {
      code: body.code,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      players: [
        { name: safeName(body.playerName, "Jugador 1"), token: hostToken, connected: false },
        null,
      ],
      settings: { targetPoints: [15, 30, 40].includes(Number(body.targetPoints)) ? Number(body.targetPoints) : 30, withFlor: Boolean(body.withFlor) },
      game: null,
    };
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + 12 * 60 * 60 * 1000);
    return json({ ok: true, token: hostToken, seat: 0 }, 201);
  }

  async joinRoom(request) {
    if (!this.room) return json({ error: "No existe una partida con ese código." }, 404);
    const body = await request.json();
    if (this.room.players[1]) return json({ error: "La partida ya tiene dos jugadores." }, 409);
    const token = randomHex(24);
    this.room.players[1] = { name: safeName(body.playerName, "Jugador 2"), token, connected: false };
    this.room.lastActivity = Date.now();
    await this.persist();
    return json({ ok: true, token, seat: 1 });
  }

  async connect(request, url) {
    if (!this.room) return json({ error: "La partida no existe o expiró." }, 404);
    const token = url.searchParams.get("token") || "";
    const seat = this.room.players.findIndex((player) => player?.token === token);
    if (seat < 0) return json({ error: "Credencial de reconexión inválida." }, 401);
    const previous = this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.seat === seat);
    for (const old of previous) { try { old.close(4001, "Sesión reemplazada por reconexión"); } catch {} }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat, token });
    this.room.players[seat].connected = true;
    this.room.lastActivity = Date.now();
    await this.persist();
    this.broadcastLobby();
    this.broadcastStates();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    const attachment = ws.deserializeAttachment();
    if (!attachment || !this.room) return;
    const seat = attachment.seat;
    let data;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (raw.length > 8192) throw new Error("Mensaje demasiado grande.");
      data = JSON.parse(raw);
    } catch (error) { this.send(ws, { type: "error", message: "Mensaje inválido." }); return; }
    this.room.lastActivity = Date.now();
    if (data.type === "ping") { this.send(ws, { type: "pong" }); return; }
    try {
      if (data.type === "start") {
        if (seat !== 0) throw new Error("Solo quien creó la sala puede iniciar la partida.");
        if (!this.room.players[1]) throw new Error("Todavía falta el segundo jugador.");
        if (!this.room.players.every((p) => p?.connected)) throw new Error("Ambos jugadores deben estar conectados.");
        if (this.room.game && !this.room.game.gameOver) throw new Error("La partida ya comenzó.");
        this.room.game = newGame(this.room.settings.targetPoints, this.room.settings.withFlor);
        startHand(this.room.game);
        await this.persist();
        await this.syncDirectoryStatus("playing");
        await this.scheduleAlarm();
        this.broadcastLobby();
        this.broadcastStates();
        return;
      }
      if (data.type === "next_hand") {
        const game = this.requireGame();
        if (game.gameOver) throw new Error("La partida terminó.");
        if (!game.handOver || game.dealing) throw new Error("Todavía no corresponde repartir.");
        game.mano = 1 - game.mano;
        startHand(game);
        await this.persist();
        await this.scheduleAlarm();
        this.broadcastStates();
        return;
      }
      if (data.type === "action") {
        const game = this.requireGame();
        this.applyAction(seat, data.action || {});
        await this.persist();
        if (this.room.game?.gameOver) await this.syncDirectoryStatus("finished");
        await this.scheduleAlarm();
        this.broadcastStates();
        return;
      }
      if (data.type === "leave") {
        this.room.players[seat].connected = false;
        await this.persist();
        this.broadcastLobby();
        return;
      }
    } catch (error) {
      this.send(ws, { type: "error", message: error instanceof Error ? error.message : "Acción no válida." });
    }
  }

  requireGame() {
    if (!this.room?.game) throw new Error("La partida todavía no comenzó.");
    return this.room.game;
  }

  applyAction(seat, action) {
    const g = this.requireGame();
    if (g.dealing || g.handOver || g.gameOver || g.envidoReveal) throw new Error("Esperá a que termine la animación o resolución actual.");
    const other = 1 - seat;
    const kind = String(action.kind || "");
    const ensureTurn = () => { if (g.turn !== seat) throw new Error("No es tu turno."); };
    const pendingByOpponent = (pending) => pending && pending.caller !== seat;
    const hasCardsToPlay = () => g.hands[seat].length > 0;

    if (kind === "play") {
      ensureTurn();
      if (g.trucoPending || g.envidoPending || g.florPending || g.resolvingTrick) throw new Error("Primero tenés que responder el canto.");
      if (g.withFlor && !g.florDone && (hasFlor(g.hands[0]) || hasFlor(g.hands[1]))) throw new Error("Hay una flor pendiente de anunciar.");
      const index = g.hands[seat].findIndex((card) => card.id === action.cardId);
      if (index < 0) throw new Error("Esa carta no está en tu mano.");
      const [card] = g.hands[seat].splice(index, 1);
      g.publicPlayed.push({ player: seat, card });
      g.currentTrick.push({ player: seat, card });
      g.envidoDone = true;
      g.turn = g.currentTrick.length === 1 ? other : null;
      g.log = `${this.room.players[seat].name} jugó una carta.`;
      if (g.currentTrick.length === 2) {
        g.resolvingTrick = true;
        g.deadlines.trickAt = Date.now() + 1000;
      }
      return;
    }

    if (kind === "call_envido" || kind === "raise_envido") {
      const type = String(action.envidoType || "");
      if (!["envido", "real", "falta"].includes(type)) throw new Error("Tipo de envido inválido.");
      if (kind === "call_envido") {
        const inTrucoResponse = pendingByOpponent(g.trucoPending);
        if (g.trucoPending && !inTrucoResponse) throw new Error("Solo quien recibió el Truco puede cantar Envido en respuesta.");
        if (!inTrucoResponse) ensureTurn();
        if (g.envidoDone || g.florPending || !g.florDone || g.tricks.length || g.currentTrick.length || g.hands[0].length !== 3 || g.hands[1].length !== 3) throw new Error("Ya no se puede cantar envido en esta mano.");
        if (g.envidoPending) throw new Error("Ya hay un envido pendiente.");
        if (g.trucoPending) { g.heldTruco = g.trucoPending; g.trucoPending = null; }
        g.envidoPending = { caller: seat, firstCaller: seat, type, committed: 0, offeredValue: offerValue(type, g), chain: 1 };
        g.log = `${this.room.players[seat].name} cantó ${type === "real" ? "Real Envido" : type === "falta" ? "Falta Envido" : "Envido"}.`;
      } else {
        const p = g.envidoPending;
        if (!p || p.caller === seat || !envidoRaiseOptions(p.type, p.chain).includes(type)) throw new Error("No podés subir a ese envido.");
        const committed = p.committed + p.offeredValue;
        g.envidoPending = { caller: seat, firstCaller: p.firstCaller ?? p.caller, type, committed, offeredValue: offerValue(type, g), chain: p.chain + 1 };
        g.log = `${this.room.players[seat].name} subió el envido.`;
      }
      return;
    }

    if (kind === "resolve_envido") {
      const p = g.envidoPending;
      if (!p || p.caller === seat) throw new Error("No hay un envido para responder.");
      g.envidoPending = null;
      if (!action.accept) {
        const points = Math.max(1, p.committed);
        g.scores[p.caller] += points;
        g.log = `Envido no querido. ${this.room.players[p.caller].name} suma ${points}.`;
        g.envidoDone = true;
        this.afterEnvido(g);
        return;
      }
      const values = [envidoPoints(g.hands[0]), envidoPoints(g.hands[1])];
      const winner = values[0] === values[1] ? g.mano : values[0] > values[1] ? 0 : 1;
      const points = p.committed + (p.type === "falta" ? faltaValueForWinner(g, winner, p.committed) : p.offeredValue);
      g.scores[winner] += points;
      g.envidoReveal = { firstCaller: p.firstCaller ?? p.caller, values, winner, points, until: Date.now() + 2600 };
      g.log = `Envido: ${this.room.players[0].name} ${values[0]} · ${this.room.players[1].name} ${values[1]}.`;
      g.deadlines.trickAt = 0;
      g.deadlines.dealAt = g.envidoReveal.until;
      return;
    }

    if (kind === "call_truco") {
      ensureTurn();
      const level = Number(action.level);
      if (g.trucoPending || g.envidoPending || g.florPending || (g.withFlor && !g.florDone && (hasFlor(g.hands[0]) || hasFlor(g.hands[1]))) || !Number.isInteger(level) || level < 1 || level > 3) throw new Error("Canto de truco inválido o hay una flor pendiente.");
      if (g.trucoLevel === 0 && level !== 1) throw new Error("Primero se canta Truco.");
      if (g.trucoLevel > 0 && (g.escalateBy !== seat || level !== g.trucoLevel + 1)) throw new Error("No te corresponde subir el truco.");
      g.trucoPending = { caller: seat, level };
      g.log = `${this.room.players[seat].name} cantó ${["", "Truco", "Retruco", "Vale cuatro"][level]}.`;
      return;
    }

    if (kind === "resolve_truco") {
      const p = g.trucoPending;
      if (!p || p.caller === seat) throw new Error("No hay un truco para responder.");
      g.trucoPending = null;
      if (!action.accept) {
        const points = p.level;
        g.scores[p.caller] += points;
        g.foldedBy = seat;
        g.foldPoints = points;
        g.log = `${this.room.players[seat].name} no quiso el truco. ${this.room.players[p.caller].name} suma ${points}.`;
        this.finishHand(g, p.caller);
      } else {
        g.trucoLevel = p.level;
        g.escalateBy = seat;
        g.log = `${this.room.players[seat].name} quiso el truco.`;
      }
      return;
    }

    if (kind === "call_flor") {
      if (!g.withFlor || g.florDone || g.florPending || g.envidoPending || !hasFlor(g.hands[seat])) throw new Error("No podés cantar flor.");
      if (g.trucoPending) { g.heldTruco = g.trucoPending; g.trucoPending = null; }
      g.envidoDone = true;
      g.florPending = { caller: seat, level: 1 };
      g.log = `${this.room.players[seat].name} cantó Flor.`;
      return;
    }

    if (kind === "raise_flor") {
      const p = g.florPending;
      const level = Number(action.level);
      if (!p || p.caller === seat || !hasFlor(g.hands[seat]) || !Number.isInteger(level) || level !== p.level + 1 || level > 3) throw new Error("No podés subir la flor.");
      g.florPending = { caller: seat, level };
      g.log = `${this.room.players[seat].name} subió la Flor.`;
      return;
    }

    if (kind === "resolve_flor") {
      const p = g.florPending;
      if (!p || p.caller === seat) throw new Error("No hay una flor para responder.");
      const responderHasFlor = hasFlor(g.hands[seat]);
      if (action.accept && !responderHasFlor) throw new Error("No tenés flor para querer.");
      const winner = action.accept
        ? (florPoints(g.hands[0]) === florPoints(g.hands[1]) ? g.mano : florPoints(g.hands[0]) > florPoints(g.hands[1]) ? 0 : 1)
        : p.caller;
      const points = p.level === 1 ? 3 : p.level === 2 ? 6 : Math.max(1, g.targetPoints - Math.max(...g.scores));
      g.scores[winner] += points;
      g.florPending = null;
      g.florDone = true;
      g.envidoDone = true;
      g.log = action.accept ? `Flor: ${florPoints(g.hands[0])} contra ${florPoints(g.hands[1])}.` : `${this.room.players[seat].name} no quiso la Flor.`;
      if (g.scores[winner] >= g.targetPoints) this.finishHand(g, winner);
      else if (g.heldTruco) { g.trucoPending = g.heldTruco; g.heldTruco = null; }
      return;
    }

    if (kind === "fold") {
      ensureTurn();
      if (g.trucoPending || g.envidoPending || g.florPending || (g.withFlor && !g.florDone && (hasFlor(g.hands[0]) || hasFlor(g.hands[1])))) throw new Error("Primero respondé el canto o esperá el anuncio de Flor.");
      const beforeFirstPlay = g.publicPlayed.length === 0 && !g.envidoDone;
      const points = g.trucoLevel ? g.trucoLevel + 1 : beforeFirstPlay ? 2 : 1;
      const winner = other;
      g.scores[winner] += points;
      g.foldedBy = seat;
      g.foldPoints = points;
      g.log = `${this.room.players[seat].name} se fue al mazo.`;
      this.finishHand(g, winner);
      return;
    }

    throw new Error("Acción desconocida.");
  }

  afterEnvido(g) {
    if (g.scores[0] >= g.targetPoints || g.scores[1] >= g.targetPoints) {
      g.gameOver = true;
      g.handOver = true;
      g.handWinner = g.scores[0] >= g.targetPoints ? 0 : 1;
      return;
    }
    if (g.heldTruco) { g.trucoPending = g.heldTruco; g.heldTruco = null; }
  }

  finishHand(g, winner) {
    if (g.handOver) return;
    g.handWinner = winner;
    g.handOver = true;
    g.resolvingTrick = false;
    g.deadlines.trickAt = 0;
    g.deadlines.dealAt = 0;
    if (g.scores[winner] >= g.targetPoints) g.gameOver = true;
    const finishReason = g.log;
    const detail = g.foldedBy !== null && finishReason ? ` ${finishReason}` : "";
    g.log = `${this.room.players[winner].name} ganó la mano. Marcador ${g.scores[0]} — ${g.scores[1]}.${detail}`;
  }

  resolveTrick(g) {
    if (!g.resolvingTrick || g.currentTrick.length !== 2) return;
    const cards = g.currentTrick.slice();
    const winner = trickWinner(cards);
    g.tricks.push({ winner, cards });
    g.lead = winner === null ? g.mano : winner;
    g.currentTrick = [];
    g.resolvingTrick = false;
    const hand = handWinner(g.tricks, g.mano);
    if (hand !== null) {
      const points = g.trucoLevel ? g.trucoLevel + 1 : 1;
      g.scores[hand] += points;
      this.finishHand(g, hand);
    } else {
      g.turn = g.lead;
      g.log = winner === null ? "Baza parda." : `${this.room.players[winner].name} ganó la baza.`;
    }
  }

  async scheduleAlarm() {
    if (!this.room) return;
    const deadlines = [this.room.lastActivity + 12 * 60 * 60 * 1000];
    const g = this.room.game;
    if (g?.deadlines?.dealAt) deadlines.push(g.deadlines.dealAt);
    if (g?.deadlines?.trickAt) deadlines.push(g.deadlines.trickAt);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
  }

  async alarm() {
    await this.ready;
    if (!this.room) return;
    const now = Date.now();
    const g = this.room.game;
    let changed = false;
    if (g?.deadlines?.dealAt && g.deadlines.dealAt <= now) {
      if (g.envidoReveal) {
        g.envidoReveal = null;
        g.envidoDone = true;
        this.afterEnvido(g);
      } else if (g.dealing) {
        g.dealing = false;
        g.deadlines.dealAt = 0;
        // Si ninguno tiene flor, ya quedó habilitado el envido y el juego normal.
      }
      if (g.deadlines.dealAt <= now) g.deadlines.dealAt = 0;
      changed = true;
    }
    if (g?.deadlines?.trickAt && g.deadlines.trickAt <= now) {
      g.deadlines.trickAt = 0;
      this.resolveTrick(g);
      changed = true;
    }
    if (now >= this.room.lastActivity + 12 * 60 * 60 * 1000) {
      if (this.ctx.getWebSockets().length === 0) {
        await this.ctx.storage.deleteAll();
        if (this.env.DB) { try { await this.env.DB.prepare("DELETE FROM rooms WHERE code=?").bind(this.room.code).run(); } catch {} }
        this.room = null;
        return;
      }
      // Una conexión todavía abierta mantiene viva la sala; renovamos su vencimiento.
      this.room.lastActivity = now;
      changed = true;
    }
    if (changed) {
      this.room.lastActivity = now;
      await this.persist();
      this.broadcastStates();
    }
    await this.scheduleAlarm();
  }

  makeView(seat) {
    const room = this.room;
    const g = room.game;
    if (!g) return null;
    return {
      roomCode: room.code,
      seat,
      opponentName: room.players[1 - seat]?.name || "Rival",
      playerName: room.players[seat]?.name || "Jugador",
      yourHand: g.hands[seat].map((card) => ({ ...card })),
      // La mano rival permanece privada hasta que el servidor declara terminada la mano.
      opponentHand: g.handOver ? g.hands[1 - seat].map((card) => ({ ...card })) : null,
      opponentCount: g.hands[1 - seat].length,
      scores: g.scores.slice(),
      mano: g.mano,
      handNo: g.handNo,
      turn: g.turn,
      lead: g.lead,
      currentTrick: g.currentTrick.map((play) => ({ player: play.player, card: { ...play.card } })),
      tricks: g.tricks.map((trick) => ({ winner: trick.winner, cards: trick.cards.map((play) => ({ player: play.player, card: { ...play.card } })) })),
      publicPlayed: g.publicPlayed.map((play) => ({ player: play.player, card: { ...play.card } })),
      trucoLevel: g.trucoLevel,
      escalateBy: g.escalateBy,
      trucoPending: g.trucoPending ? { ...g.trucoPending } : null,
      envidoPending: g.envidoPending ? { ...g.envidoPending } : null,
      florPending: g.florPending ? { ...g.florPending } : null,
      heldTruco: g.heldTruco ? { ...g.heldTruco } : null,
      envidoDone: g.envidoDone,
      florDone: g.florDone,
      withFlor: g.withFlor,
      targetPoints: g.targetPoints,
      dealing: g.dealing,
      handOver: g.handOver,
      gameOver: g.gameOver,
      resolvingTrick: g.resolvingTrick,
      foldedBy: g.foldedBy,
      foldPoints: g.foldPoints,
      handWinner: g.handWinner,
      handScoreAtStart: g.handScoreAtStart.slice(),
      envidoReveal: g.envidoReveal ? {
        firstCaller: g.envidoReveal.firstCaller,
        values: g.envidoReveal.values.slice(),
        winner: g.envidoReveal.winner,
        points: g.envidoReveal.points,
      } : null,
      log: g.log,
    };
  }

  send(ws, data) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch {}
  }

  broadcastLobby() {
    if (!this.room) return;
    const data = {
      type: "lobby",
      code: this.room.code,
      players: this.room.players.map((p) => p ? { name: p.name, connected: !!p.connected } : null),
      started: !!this.room.game,
      canStart: !!this.room.players[0]?.connected && !!this.room.players[1]?.connected && !this.room.game,
    };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, data);
  }

  broadcastStates() {
    if (!this.room?.game) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment) continue;
      this.send(ws, { type: "state", state: this.makeView(attachment.seat) });
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    const attachment = ws.deserializeAttachment();
    if (!attachment || !this.room) return;
    const seat = attachment.seat;
    const remaining = this.ctx.getWebSockets().some((other) => other !== ws && other.deserializeAttachment()?.seat === seat);
    if (!remaining && this.room.players[seat]) this.room.players[seat].connected = false;
    this.room.lastActivity = Date.now();
    await this.persist();
    this.broadcastLobby();
    await this.scheduleAlarm();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
