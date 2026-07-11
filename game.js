"use strict";

// ---------------------------------------------------------------------------
// カード定義
// 各カードは自分の番の「数を進める」前に何枚でも使用できる。
// ---------------------------------------------------------------------------
const CARD_TYPES = [
  {
    id: "double_limit",
    name: "倍プッシュ",
    desc: "上限の数を2倍にする",
    color: "#e74c3c",
    effect(state) {
      state.limit *= 2;
      return `上限が ${state.limit / 2} → ${state.limit} になった!`;
    },
  },
  {
    id: "count_boost",
    name: "カウントブースト",
    desc: "このターンだけ、進められる数の最大値が+2される",
    color: "#e67e22",
    effect(state) {
      state.turnAdvanceBonus += 2;
      return "このターンの最大カウント数が+2された!";
    },
  },
  {
    id: "rewind",
    name: "まきもどし",
    desc: "現在のカウントを3つ戻す(0未満にはならない)",
    color: "#2ecc71",
    effect(state) {
      const before = state.count;
      state.count = Math.max(0, state.count - 3);
      return `カウントが ${before} → ${state.count} に巻き戻った!`;
    },
  },
  {
    id: "skip",
    name: "スキップ",
    desc: "次のプレイヤーの番を1回とばす",
    color: "#9b59b6",
    effect(state) {
      state.skipNext = true;
      return "次のプレイヤーの番がスキップされる!";
    },
  },
  {
    id: "reverse",
    name: "ぎゃくしゅう",
    desc: "手番が進む方向を逆にする",
    color: "#3498db",
    effect(state) {
      state.direction *= -1;
      return "手番の進行方向が逆になった!";
    },
  },
  {
    id: "forced_number",
    name: "しばりナンバー",
    desc: "次のプレイヤーは、自分のターンで1つしか進められなくなる",
    color: "#34495e",
    effect(state) {
      state.pendingForcedCap = 1;
      return "次のプレイヤーの最大カウント数が1に縛られた!";
    },
  },
  {
    id: "reset_count",
    name: "リセット",
    desc: "カウントを0に戻す",
    color: "#1abc9c",
    effect(state) {
      state.count = 0;
      return "カウントが0にリセットされた!";
    },
  },
  {
    id: "draw_card",
    name: "ドロー",
    desc: "山札からカードを1枚引く",
    color: "#f1c40f",
    effect(state, playerIndex) {
      const card = state.deck.pop();
      if (card) {
        state.players[playerIndex].hand.push(card);
        return "山札からカードを1枚引いた。";
      }
      return "山札が空だった…";
    },
  },
  {
    id: "safeguard",
    name: "まもり",
    desc: "上限に到達しても1回だけ負けを回避する(発動するとカウントは0に戻る)",
    color: "#95a5a6",
    effect(state, playerIndex) {
      state.players[playerIndex].safeguard = true;
      return "「まもり」がセットされた。負けを1回だけ回避できる。";
    },
  },
];

const CARD_MAP = Object.fromEntries(CARD_TYPES.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// ゲーム状態
// ---------------------------------------------------------------------------
let state = null;

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(copiesPerCard) {
  const deck = [];
  for (const card of CARD_TYPES) {
    for (let i = 0; i < copiesPerCard; i++) deck.push(card.id);
  }
  return shuffle(deck);
}

function createGame(config) {
  const deck = buildDeck(config.deckCopies);
  const players = config.playerNames.map((name, i) => ({
    id: i,
    name: name || `プレイヤー${i + 1}`,
    hand: [],
    safeguard: false,
  }));

  for (const player of players) {
    for (let i = 0; i < config.handSize; i++) {
      const card = deck.pop();
      if (card) player.hand.push(card);
    }
  }

  return {
    limit: config.limit,
    baseMaxAdvance: config.maxAdvance,
    turnAdvanceBonus: 0,
    pendingForcedCap: null,
    count: 0,
    players,
    direction: 1,
    currentPlayerIndex: 0,
    skipNext: false,
    deck,
    log: [],
  };
}

function addLog(message, highlight) {
  state.log.push({ message, highlight: !!highlight });
}

function nextIndex(fromIndex) {
  const n = state.players.length;
  return (fromIndex + state.direction + n) % n;
}

function effectiveMaxAdvance() {
  const base = state.turnBaseCap != null ? state.turnBaseCap : state.baseMaxAdvance;
  return Math.max(1, base + state.turnAdvanceBonus);
}

function startTurn(playerIndex) {
  state.currentPlayerIndex = playerIndex;
  state.turnAdvanceBonus = 0;
  if (state.pendingForcedCap != null) {
    state.turnBaseCap = state.pendingForcedCap;
    state.pendingForcedCap = null;
  } else {
    state.turnBaseCap = null;
  }
}

function playCard(cardIndex) {
  const player = state.players[state.currentPlayerIndex];
  const cardId = player.hand[cardIndex];
  if (!cardId) return;
  const card = CARD_MAP[cardId];
  player.hand.splice(cardIndex, 1);
  const resultMessage = card.effect(state, state.currentPlayerIndex);
  addLog(`${player.name} が「${card.name}」を使った。${resultMessage}`);
  render();
}

function advanceCount(amount) {
  const player = state.players[state.currentPlayerIndex];
  const newCount = state.count + amount;
  state.count = newCount;

  const nums =
    amount === 1
      ? `${newCount}`
      : `${state.count - amount + 1}〜${newCount}`;
  addLog(`${player.name} が「${nums}」と言った。(残り${state.limit - newCount})`);

  if (newCount >= state.limit) {
    if (player.safeguard) {
      player.safeguard = false;
      state.count = 0;
      addLog(`${player.name} は上限に到達したが「まもり」で回避!カウントは0に戻った。`, true);
      endTurnAndAdvance();
      return;
    }
    addLog(`${player.name} が上限の数(${state.limit})に到達し、負けた!`, true);
    finishGame(player);
    return;
  }

  endTurnAndAdvance();
}

function endTurnAndAdvance() {
  let next = nextIndex(state.currentPlayerIndex);
  if (state.skipNext) {
    state.skipNext = false;
    addLog(`${state.players[next].name} の番はスキップされた。`, true);
    next = nextIndex(next);
  }
  startTurn(next);
  showTransitionScreen();
}

function finishGame(loser) {
  const winners = state.players.filter((p) => p !== loser);
  const title =
    winners.length === 1
      ? `${winners[0].name} の勝利!(${loser.name} の負け)`
      : `${loser.name} の負け!(${winners.map((p) => p.name).join("・")} の勝ち)`;
  document.getElementById("result-title").textContent = title;
  showScreen("result-screen");
}

// ---------------------------------------------------------------------------
// 画面制御
// ---------------------------------------------------------------------------
function showScreen(id) {
  for (const el of document.querySelectorAll(".screen")) {
    el.hidden = el.id !== id;
  }
}

function showTransitionScreen() {
  const player = state.players[state.currentPlayerIndex];
  document.getElementById("transition-player-name").textContent = player.name;
  showScreen("transition-screen");
}

function render() {
  const player = state.players[state.currentPlayerIndex];

  document.getElementById("current-count").textContent = state.count;
  document.getElementById("current-limit").textContent = state.limit;
  document.getElementById("current-direction").textContent =
    state.direction === 1 ? "→" : "←";
  document.getElementById("current-turn-label").textContent = `${player.name} の番`;

  const overview = document.getElementById("players-overview");
  overview.innerHTML = "";
  state.players.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "player-chip";
    if (i === state.currentPlayerIndex) chip.classList.add("current");
    chip.textContent = `${p.name} (手札${p.hand.length}${p.safeguard ? " 🛡" : ""})`;
    overview.appendChild(chip);
  });

  const handArea = document.getElementById("hand-area");
  handArea.innerHTML = "";
  if (player.hand.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hand-empty";
    empty.textContent = "手札がありません。";
    handArea.appendChild(empty);
  } else {
    player.hand.forEach((cardId, idx) => {
      const card = CARD_MAP[cardId];
      const btn = document.createElement("button");
      btn.className = "card-btn";
      btn.style.background = card.color;
      btn.type = "button";
      btn.innerHTML = `<span class="card-name">${card.name}</span><span class="card-desc">${card.desc}</span>`;
      btn.addEventListener("click", () => playCard(idx));
      handArea.appendChild(btn);
    });
  }

  const maxAdvance = Math.min(effectiveMaxAdvance(), state.limit - state.count);
  document.getElementById("max-advance-display").textContent = effectiveMaxAdvance();

  const moveArea = document.getElementById("move-area");
  moveArea.innerHTML = "";
  for (let a = 1; a <= maxAdvance; a++) {
    const btn = document.createElement("button");
    btn.className = "move-btn";
    if (state.count + a >= state.limit) btn.classList.add("danger");
    btn.type = "button";
    btn.textContent = a;
    btn.addEventListener("click", () => advanceCount(a));
    moveArea.appendChild(btn);
  }

  const logArea = document.getElementById("log-area");
  logArea.innerHTML = "";
  const recent = state.log.slice(-50).reverse();
  for (const entry of recent) {
    const p = document.createElement("p");
    if (entry.highlight) p.className = "log-highlight";
    p.textContent = entry.message;
    logArea.appendChild(p);
  }
}

// ---------------------------------------------------------------------------
// セットアップ画面
// ---------------------------------------------------------------------------
function renderPlayerNameFields() {
  const count = clampInt(document.getElementById("player-count").value, 2, 6, 3);
  const container = document.getElementById("player-name-fields");
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "field-row";
    const label = document.createElement("label");
    label.textContent = `プレイヤー${i + 1}の名前`;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 12;
    input.id = `player-name-${i}`;
    input.placeholder = `プレイヤー${i + 1}`;
    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function startGame() {
  const errorEl = document.getElementById("setup-error");
  errorEl.hidden = true;

  const playerCount = clampInt(document.getElementById("player-count").value, 2, 6, 3);
  const limit = clampInt(document.getElementById("limit-number").value, 5, 100000, 30);
  const maxAdvance = clampInt(document.getElementById("max-advance").value, 1, limit - 1, 3);
  const handSize = clampInt(document.getElementById("hand-size").value, 0, 20, 3);
  const deckCopies = clampInt(document.getElementById("deck-copies").value, 1, 20, 4);

  const playerNames = [];
  for (let i = 0; i < playerCount; i++) {
    const input = document.getElementById(`player-name-${i}`);
    playerNames.push(input && input.value.trim() ? input.value.trim() : "");
  }

  state = createGame({ playerNames, limit, maxAdvance, handSize, deckCopies });
  startTurn(0);
  addLog(`ゲーム開始!上限${state.limit} / 最大カウント${state.baseMaxAdvance}`, true);
  showTransitionScreen();
}

// ---------------------------------------------------------------------------
// ルールモーダル
// ---------------------------------------------------------------------------
function renderRulesModal() {
  const list = document.getElementById("rules-card-list");
  list.innerHTML = "";
  for (const card of CARD_TYPES) {
    const box = document.createElement("div");
    box.className = "card-btn";
    box.style.background = card.color;
    box.innerHTML = `<span class="card-name">${card.name}</span><span class="card-desc">${card.desc}</span>`;
    list.appendChild(box);
  }
}

// ---------------------------------------------------------------------------
// イベント登録
// ---------------------------------------------------------------------------
document.getElementById("player-count").addEventListener("input", renderPlayerNameFields);
document.getElementById("start-game-btn").addEventListener("click", startGame);

document.getElementById("reveal-hand-btn").addEventListener("click", () => {
  showScreen("game-screen");
  render();
});

document.getElementById("restart-btn").addEventListener("click", () => {
  state = null;
  showScreen("setup-screen");
});

document.getElementById("rules-open-btn").addEventListener("click", () => {
  document.getElementById("rules-modal").hidden = false;
});
document.getElementById("rules-close-btn").addEventListener("click", () => {
  document.getElementById("rules-modal").hidden = true;
});
document.getElementById("rules-modal").addEventListener("click", (e) => {
  if (e.target.id === "rules-modal") document.getElementById("rules-modal").hidden = true;
});

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
renderPlayerNameFields();
renderRulesModal();
showScreen("setup-screen");
