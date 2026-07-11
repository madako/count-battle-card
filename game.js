"use strict";

// ---------------------------------------------------------------------------
// カード定義
// ---------------------------------------------------------------------------
// 各カードは id/name/desc/color に加えて、以下を任意で持てる:
//   - category: "attack" ... 「攻撃」カード。対象プレイヤーへ不利な効果を与える
//   - sub: 副効果タグの配列。"速攻" / "cha" / "enc" を指定できる
//       速攻: 1ターン1枚の通常制限を無視して何枚でも使える
//       cha : 自分のターンでなくても、他人がカードを使った直後に割り込んで使える
//             (通常の手札クリックでは使えず、cha発動チャンスでのみ使用可)
//       enc : 他のカードと同時に使うことでそのカードに変化を与える
//             (通常の手札クリックでは使えず、他カード使用時の添付選択でのみ使用可)
//   - needsTarget: true ... 使用時に対象プレイヤーを1人選ばせる
//   - choices: [{key,label}, ...] ... 使用時に選択肢を選ばせる
//   - peek: N ... 使用時に山札の上からN枚を見せて1枚選ばせる
//   - magnitude: 数値効果の基準値。enc「up grade」で1.5倍(小数点切り捨て)される
//   - encModify(context): enc カード専用。同時に使われたカードのcontextを書き換える
//   - effect(state, playerIndex, context): 効果本体。ログに乗せる文字列を返す
// ---------------------------------------------------------------------------
const CARD_TYPES = [
  {
    id: "double_limit",
    name: "倍プッシュ",
    desc: "上限の数を2倍にする",
    color: "#e74c3c",
    magnitude: 2,
    effect(state, playerIndex, context) {
      const mag = context.magnitude != null ? context.magnitude : 2;
      const before = state.limit;
      state.limit *= mag;
      return `上限が ${before} → ${state.limit} になった!`;
    },
  },
  {
    id: "count_boost",
    name: "カウントブースト",
    desc: "このターンだけ、進められる数の最大値が+2される",
    color: "#e67e22",
    magnitude: 2,
    effect(state, playerIndex, context) {
      const mag = context.magnitude != null ? context.magnitude : 2;
      state.turnAdvanceBonus += mag;
      return `このターンの最大カウント数が+${mag}された!`;
    },
  },
  {
    id: "dash",
    name: "ダッシュ",
    desc: "(速攻)このターンだけ、進められる数の最大値が+1される。何枚でも重ねて使える",
    color: "#f39c12",
    sub: ["速攻"],
    magnitude: 1,
    effect(state, playerIndex, context) {
      const mag = context.magnitude != null ? context.magnitude : 1;
      state.turnAdvanceBonus += mag;
      return `このターンの最大カウント数が+${mag}された!(速攻)`;
    },
  },
  {
    id: "time_trick",
    name: "タイムトリック",
    desc: "現在のカウントを+5か-5する(0未満にはならない)",
    color: "#2ecc71",
    magnitude: 5,
    choices: [
      { key: "plus", label: "+5する" },
      { key: "minus", label: "-5する" },
    ],
    effect(state, playerIndex, context) {
      const mag = context.magnitude != null ? context.magnitude : 5;
      const sign = context.choice === "minus" ? -1 : 1;
      const before = state.count;
      state.count = Math.max(0, state.count + sign * mag);
      return `カウントが ${before} → ${state.count} に変化した!`;
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
    id: "draw_card",
    name: "ドロー",
    desc: "山札からカードを2枚引く",
    color: "#f1c40f",
    magnitude: 2,
    effect(state, playerIndex, context) {
      const mag = context.magnitude != null ? context.magnitude : 2;
      const player = state.players[playerIndex];
      let drawn = 0;
      for (let i = 0; i < mag; i++) {
        const card = state.deck.pop();
        if (!card) break;
        player.hand.push(card);
        drawn++;
      }
      return drawn > 0 ? `山札から${drawn}枚引いた。` : "山札が空だった…";
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
  {
    id: "new_game",
    name: "強くてニューゲーム",
    desc: "カウントを0に戻し、手札をすべて山札に戻してシャッフルし、開始時の手札枚数+2枚を引き直す。さらに自分だけ最大カウント数が2倍になる",
    color: "#8e44ad",
    effect(state, playerIndex) {
      const player = state.players[playerIndex];
      const before = state.count;
      state.count = 0;
      state.deck.push(...player.hand);
      player.hand = [];
      state.deck = shuffle(state.deck);
      const drawCount = state.initialHandSize + 2;
      let drawn = 0;
      for (let i = 0; i < drawCount; i++) {
        const card = state.deck.pop();
        if (!card) break;
        player.hand.push(card);
        drawn++;
      }
      player.advanceMultiplier = 2;
      return `カウントが${before}→0にリセットされ、手札が入れ替わった(${drawn}枚)。${player.name}だけ最大カウント数が2倍になった!`;
    },
  },
  {
    id: "choose",
    name: "choose",
    desc: "山札の上から5枚を見て、その中から好きな1枚を引く",
    color: "#16a085",
    peek: 5,
    effect(state, playerIndex, context) {
      const player = state.players[playerIndex];
      let peeked = context.peeked;
      if (!peeked) {
        peeked = [];
        for (let i = 0; i < 5; i++) {
          const card = state.deck.pop();
          if (card) peeked.push(card);
        }
      }
      if (!peeked.length) return "山札が空だった…";
      let chosenId = context.choice;
      if (chosenId == null || !peeked.includes(chosenId)) {
        chosenId = peeked[Math.floor(Math.random() * peeked.length)];
      }
      const rest = peeked.slice();
      rest.splice(rest.indexOf(chosenId), 1);
      player.hand.push(chosenId);
      state.deck.push(...rest);
      state.deck = shuffle(state.deck);
      return `山札から「${CARD_MAP[chosenId].name}」を引いた。`;
    },
  },
  {
    id: "steal",
    name: "steal",
    desc: "(攻撃)対象を1人選び、その人の手札からランダムに1枚奪う",
    color: "#c0392b",
    category: "attack",
    needsTarget: true,
    effect(state, playerIndex, context) {
      let casterIndex = playerIndex;
      let targetIndex = context.targetIndex;
      if (targetIndex == null) {
        const others = state.players.map((_, i) => i).filter((i) => i !== casterIndex);
        targetIndex = others[Math.floor(Math.random() * others.length)];
      }
      const target = state.players[targetIndex];
      if (target.reflect) {
        target.reflect = false;
        addLog(`${target.name}の「reflection」が発動し、効果が跳ね返った!`, true);
        const tmp = casterIndex;
        casterIndex = targetIndex;
        targetIndex = tmp;
      }
      const caster = state.players[casterIndex];
      const finalTarget = state.players[targetIndex];
      if (!finalTarget.hand.length) {
        return `${finalTarget.name}の手札は空だったので何も奪えなかった。`;
      }
      const stealIdx = Math.floor(Math.random() * finalTarget.hand.length);
      const stolenId = finalTarget.hand.splice(stealIdx, 1)[0];
      caster.hand.push(stolenId);
      return `${caster.name}が${finalTarget.name}から「${CARD_MAP[stolenId].name}」を奪った!`;
    },
  },
  {
    id: "reflection",
    name: "reflection",
    desc: "次に「攻撃」カードの対象になった時、その効果を発動者に跳ね返す(1回限り)",
    color: "#7f8fa6",
    effect(state, playerIndex) {
      state.players[playerIndex].reflect = true;
      return "「reflection」がセットされた。次の攻撃を跳ね返せる。";
    },
  },
  {
    id: "grave_robber",
    name: "墓荒らし",
    desc: "墓地からカードをランダムに1枚引く",
    color: "#6c5b4c",
    effect(state, playerIndex) {
      if (!state.graveyard.length) return "墓地は空だった…";
      const idx = Math.floor(Math.random() * state.graveyard.length);
      const cardId = state.graveyard.splice(idx, 1)[0];
      state.players[playerIndex].hand.push(cardId);
      return `墓地から「${CARD_MAP[cardId].name}」を引いた!`;
    },
  },
  {
    id: "copy_card",
    name: "コピー",
    desc: "直前に使われたカードの効果をもう一度発動する(コピー自身はコピーできない)",
    color: "#576574",
    effect(state, playerIndex) {
      const last = state.lastPlayedCard;
      if (!last || last.cardId === "copy_card") return "コピーできる効果がなかった。";
      const lastCard = CARD_MAP[last.cardId];
      const msg = runCardEffect(lastCard, playerIndex, {});
      return `「${lastCard.name}」の効果をコピーした。${msg}`;
    },
  },
  {
    id: "cha_deny",
    name: "chaカード禁止",
    desc: "(cha)相手が使ったカードの効果を打ち消す",
    color: "#2c3e50",
    sub: ["cha"],
  },
  {
    id: "cha_copy",
    name: "chaコピー",
    desc: "(cha)相手が使ったカードの効果を自分にもコピーする",
    color: "#34495e",
    sub: ["cha"],
  },
  {
    id: "up_grade",
    name: "up grade",
    desc: "(enc)同時に使ったカードの数値効果を1.5倍(小数点切り捨て)にする",
    color: "#d35400",
    sub: ["enc"],
    encModify(context) {
      context.encMultiply = (context.encMultiply || 1) * 1.5;
    },
  },
  {
    id: "speed_up",
    name: "speed up",
    desc: "(enc)同時に使ったカードに「速攻」を与え、このターンの使用回数制限を無視できるようにする",
    color: "#e67e22",
    sub: ["enc"],
    encModify(context) {
      context.forceSpeed = true;
    },
  },
];

const CARD_MAP = Object.fromEntries(CARD_TYPES.map((c) => [c.id, c]));

function hasSub(card, tag) {
  return !!(card.sub && card.sub.includes(tag));
}

function isDirectlyPlayable(card) {
  return !hasSub(card, "enc") && !hasSub(card, "cha");
}

// magnitude(数値効果の基準値)を enc の倍率込みで計算してから effect を呼ぶ共通経路。
// すべてのカード効果の発動はここを通す(通常発動・chaコピー・カードのコピー、いずれも同じ)。
function runCardEffect(card, playerIndex, context) {
  context = context || {};
  if (card.magnitude != null && context.magnitude == null) {
    context.magnitude = Math.max(0, Math.floor(card.magnitude * (context.encMultiply || 1)));
  }
  return card.effect(state, playerIndex, context);
}

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
    reflect: false,
    advanceMultiplier: 1,
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
    turnBaseCap: null,
    count: 0,
    players,
    direction: 1,
    currentPlayerIndex: 0,
    skipNext: false,
    deck,
    graveyard: [],
    initialHandSize: config.handSize,
    cardsPlayedThisTurn: 0,
    lastPlayedCard: null,
    pendingPlay: null,
    chaPhase: null,
    log: [],
  };
}

function addLog(message, highlight) {
  state.log.push({ message, highlight: !!highlight });
}

function moveToGraveyard(cardId) {
  state.graveyard.push(cardId);
}

function nextIndex(fromIndex) {
  const n = state.players.length;
  return (fromIndex + state.direction + n) % n;
}

function effectiveMaxAdvance() {
  const player = state.players[state.currentPlayerIndex];
  const base = state.turnBaseCap != null ? state.turnBaseCap : state.baseMaxAdvance;
  const withBonus = base + state.turnAdvanceBonus;
  return Math.max(1, withBonus * (player.advanceMultiplier || 1));
}

function startTurn(playerIndex) {
  state.currentPlayerIndex = playerIndex;
  state.turnAdvanceBonus = 0;
  state.cardsPlayedThisTurn = 0;
  if (state.pendingForcedCap != null) {
    state.turnBaseCap = state.pendingForcedCap;
    state.pendingForcedCap = null;
  } else {
    state.turnBaseCap = null;
  }
}

// ---------------------------------------------------------------------------
// カード使用フロー(enc添付 → 対象選択 → 選択肢 → 山札を見て選ぶ → 解決)
// 現在の手番のプレイヤー自身の操作なので、目隠し不要でその場のモーダルで進める。
// ---------------------------------------------------------------------------
function eligibleEncIndexes() {
  const player = state.players[state.currentPlayerIndex];
  const hostIndex = state.pendingPlay.handIndex;
  const list = [];
  player.hand.forEach((id, i) => {
    if (i === hostIndex) return;
    if (hasSub(CARD_MAP[id], "enc")) list.push(i);
  });
  return list;
}

function beginCardPlay(handIndex) {
  const player = state.players[state.currentPlayerIndex];
  const cardId = player.hand[handIndex];
  const card = CARD_MAP[cardId];
  if (!card || !isDirectlyPlayable(card)) return;
  state.pendingPlay = {
    handIndex,
    cardId,
    encHandIndex: null,
    encAsked: false,
    targetIndex: null,
    choice: null,
    peeked: null,
    peekDone: false,
    step: null,
  };
  advancePlayFlow();
}

function advancePlayFlow() {
  const pp = state.pendingPlay;
  const card = CARD_MAP[pp.cardId];

  if (!pp.encAsked) {
    if (eligibleEncIndexes().length > 0) {
      pp.step = "enc";
      render();
      return;
    }
    pp.encAsked = true;
  }

  if (card.needsTarget && pp.targetIndex == null) {
    pp.step = "target";
    render();
    return;
  }

  if (card.choices && pp.choice == null) {
    pp.step = "choice";
    render();
    return;
  }

  if (card.peek && !pp.peekDone) {
    pp.peekDone = true;
    pp.peeked = [];
    for (let i = 0; i < card.peek; i++) {
      const c = state.deck.pop();
      if (c) pp.peeked.push(c);
    }
    if (pp.peeked.length > 0) {
      pp.step = "peek";
      render();
      return;
    }
  }

  resolvePlayFlow();
}

function chooseEncForPlay(encIndex) {
  state.pendingPlay.encHandIndex = encIndex;
  state.pendingPlay.encAsked = true;
  advancePlayFlow();
}

function chooseTargetForPlay(targetIndex) {
  state.pendingPlay.targetIndex = targetIndex;
  advancePlayFlow();
}

function chooseChoiceForPlay(key) {
  state.pendingPlay.choice = key;
  advancePlayFlow();
}

function choosePeekForPlay(cardId) {
  state.pendingPlay.choice = cardId;
  advancePlayFlow();
}

function cancelPlayFlow() {
  const pp = state.pendingPlay;
  if (pp && pp.peeked) {
    // 見た5枚は山札に戻してシャッフルし直す(見た情報は失われる)
    state.deck.push(...pp.peeked);
    state.deck = shuffle(state.deck);
  }
  state.pendingPlay = null;
  render();
}

function resolvePlayFlow() {
  const pp = state.pendingPlay;
  const player = state.players[state.currentPlayerIndex];
  const card = CARD_MAP[pp.cardId];

  const context = {};
  if (pp.targetIndex != null) context.targetIndex = pp.targetIndex;
  if (pp.choice != null) context.choice = pp.choice;
  if (pp.peeked != null) context.peeked = pp.peeked.slice();

  let encCard = null;
  if (pp.encHandIndex != null) {
    encCard = CARD_MAP[player.hand[pp.encHandIndex]];
  }
  if (encCard) encCard.encModify(context);

  const isSpeedy = hasSub(card, "速攻") || context.forceSpeed === true;
  if (!isSpeedy && state.cardsPlayedThisTurn > 0) {
    addLog(`「${card.name}」は使えなかった(このターンはすでに通常カードを使用済み)。`, true);
    if (pp.peeked) {
      state.deck.push(...pp.peeked);
      state.deck = shuffle(state.deck);
    }
    state.pendingPlay = null;
    render();
    return;
  }

  const indexesToRemove = [pp.handIndex];
  if (pp.encHandIndex != null) indexesToRemove.push(pp.encHandIndex);
  indexesToRemove.sort((a, b) => b - a);
  for (const idx of indexesToRemove) {
    const removedId = player.hand.splice(idx, 1)[0];
    moveToGraveyard(removedId);
  }

  if (!isSpeedy) state.cardsPlayedThisTurn += 1;

  state.pendingPlay = null;
  beginChaPhase(state.currentPlayerIndex, card, context);
}

// ---------------------------------------------------------------------------
// chaフェーズ: 他プレイヤーがcha付きカードで割り込めるかを、手番順に確認していく。
// cha付きカードを持っていないプレイヤーは目隠し画面を出さず黙ってスキップする。
// ---------------------------------------------------------------------------
function beginChaPhase(hostPlayerIndex, card, context) {
  const queue = [];
  let idx = hostPlayerIndex;
  for (let i = 0; i < state.players.length - 1; i++) {
    idx = nextIndex(idx);
    queue.push(idx);
  }
  state.chaPhase = {
    hostPlayerIndex,
    cardId: card.id,
    context,
    queue,
    nullified: false,
    copiers: [],
    currentResponder: null,
    anyRevealed: false,
  };
  advanceChaPhase();
}

function advanceChaPhase() {
  const phase = state.chaPhase;
  if (!phase) return;
  while (phase.queue.length) {
    const responder = phase.queue.shift();
    const hasChaCard = state.players[responder].hand.some((id) => hasSub(CARD_MAP[id], "cha"));
    if (hasChaCard) {
      phase.currentResponder = responder;
      phase.anyRevealed = true;
      showChaTransitionScreen(responder);
      return;
    }
  }
  finishChaPhase();
}

function showChaTransitionScreen(responder) {
  const player = state.players[responder];
  document.getElementById("cha-transition-player-name").textContent = player.name;
  showScreen("cha-transition-screen");
}

function revealChaResponse() {
  showScreen("cha-response-screen");
  renderChaResponseScreen();
}

function renderChaResponseScreen() {
  const phase = state.chaPhase;
  const responder = phase.currentResponder;
  const player = state.players[responder];
  const hostCard = CARD_MAP[phase.cardId];

  document.getElementById("cha-response-player-name").textContent = player.name;
  document.getElementById("cha-response-host-card").textContent =
    `${state.players[phase.hostPlayerIndex].name}が「${hostCard.name}」を使用!割り込みますか?`;

  const area = document.getElementById("cha-response-cards");
  area.innerHTML = "";
  player.hand.forEach((cardId, idx) => {
    const c = CARD_MAP[cardId];
    if (!hasSub(c, "cha")) return;
    const btn = document.createElement("button");
    btn.className = "card-btn";
    btn.style.background = c.color;
    btn.type = "button";
    btn.innerHTML = `<span class="card-name">${c.name}</span><span class="card-desc">${c.desc}</span>`;
    btn.addEventListener("click", () => playChaResponse(idx));
    area.appendChild(btn);
  });
}

function playChaResponse(handIndex) {
  const phase = state.chaPhase;
  const responder = phase.currentResponder;
  const player = state.players[responder];
  const cardId = player.hand.splice(handIndex, 1)[0];
  moveToGraveyard(cardId);
  const card = CARD_MAP[cardId];
  const hostCard = CARD_MAP[phase.cardId];

  if (card.id === "cha_deny") {
    phase.nullified = true;
    addLog(`${player.name}が「${card.name}」で${state.players[phase.hostPlayerIndex].name}の「${hostCard.name}」を打ち消した!`, true);
  } else if (card.id === "cha_copy") {
    phase.copiers.push(responder);
    addLog(`${player.name}が「${card.name}」で「${hostCard.name}」の効果を自分にもコピーする!`, true);
  }

  passChaResponse();
}

function passChaResponse() {
  state.chaPhase.currentResponder = null;
  advanceChaPhase();
}

function finishChaPhase() {
  const phase = state.chaPhase;
  const hostCard = CARD_MAP[phase.cardId];
  const hostIndex = phase.hostPlayerIndex;

  if (phase.nullified) {
    addLog(`「${hostCard.name}」の効果は打ち消されて発動しなかった。`, true);
  } else {
    const msg = runCardEffect(hostCard, hostIndex, phase.context);
    addLog(`${state.players[hostIndex].name}が「${hostCard.name}」を使った。${msg}`);
  }

  for (const copierIndex of phase.copiers) {
    const copyContext = Object.assign({}, phase.context);
    const msg = runCardEffect(hostCard, copierIndex, copyContext);
    addLog(`${state.players[copierIndex].name}にも「${hostCard.name}」の効果がコピーされた。${msg}`);
  }

  state.lastPlayedCard = { cardId: hostCard.id, playerIndex: hostIndex };
  const wasRevealed = phase.anyRevealed;
  state.chaPhase = null;

  if (wasRevealed) {
    document.getElementById("transition-player-name").textContent = state.players[hostIndex].name;
    showScreen("transition-screen");
  } else {
    render();
  }
}

// ---------------------------------------------------------------------------
// カウント進行
// ---------------------------------------------------------------------------
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
  // カード使用フローのモーダルは画面遷移時に必ず閉じる(残って他画面をブロックしないように)
  document.getElementById("play-modal").hidden = true;
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
  document.getElementById("current-graveyard").textContent = state.graveyard.length;
  document.getElementById("current-turn-label").textContent = `${player.name} の番`;

  const overview = document.getElementById("players-overview");
  overview.innerHTML = "";
  state.players.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "player-chip";
    if (i === state.currentPlayerIndex) chip.classList.add("current");
    chip.textContent = `${p.name} (手札${p.hand.length}${p.safeguard ? " 🛡" : ""}${p.reflect ? " 🪞" : ""})`;
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
      const tag = card.category === "attack" ? " [攻撃]" : hasSub(card, "enc") ? " [enc]" : hasSub(card, "cha") ? " [cha]" : "";
      btn.innerHTML = `<span class="card-name">${card.name}${tag}</span><span class="card-desc">${card.desc}</span>`;
      if (isDirectlyPlayable(card)) {
        btn.addEventListener("click", () => beginCardPlay(idx));
      } else {
        btn.classList.add("card-btn-locked");
        btn.addEventListener("click", () => {
          addLog(`「${card.name}」は他のカードと同時に使う(enc)か、相手のカード使用時に割り込む(cha)専用のカードです。`, true);
          render();
        });
      }
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

  renderPlayModal();
}

function renderPlayModal() {
  const modal = document.getElementById("play-modal");
  const pp = state.pendingPlay;
  if (!pp) {
    modal.hidden = true;
    return;
  }
  modal.hidden = false;
  const card = CARD_MAP[pp.cardId];
  const body = document.getElementById("play-modal-body");
  body.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = `「${card.name}」を使用`;
  body.appendChild(title);

  if (pp.step === "enc") {
    const desc = document.createElement("p");
    desc.textContent = "同時に使う enc カードを選べます(選ばなくてもOK)。";
    body.appendChild(desc);
    eligibleEncIndexes().forEach((idx) => {
      const c = CARD_MAP[state.players[state.currentPlayerIndex].hand[idx]];
      const btn = document.createElement("button");
      btn.className = "card-btn";
      btn.style.background = c.color;
      btn.type = "button";
      btn.innerHTML = `<span class="card-name">${c.name}</span><span class="card-desc">${c.desc}</span>`;
      btn.addEventListener("click", () => chooseEncForPlay(idx));
      body.appendChild(btn);
    });
    const skipBtn = document.createElement("button");
    skipBtn.className = "secondary-btn";
    skipBtn.type = "button";
    skipBtn.textContent = "つけずに使う";
    skipBtn.addEventListener("click", () => chooseEncForPlay(null));
    body.appendChild(skipBtn);
  } else if (pp.step === "target") {
    const desc = document.createElement("p");
    desc.textContent = "対象のプレイヤーを選んでください。";
    body.appendChild(desc);
    state.players.forEach((p, idx) => {
      if (idx === state.currentPlayerIndex) return;
      const btn = document.createElement("button");
      btn.className = "move-btn";
      btn.type = "button";
      btn.textContent = p.name;
      btn.addEventListener("click", () => chooseTargetForPlay(idx));
      body.appendChild(btn);
    });
  } else if (pp.step === "choice") {
    const desc = document.createElement("p");
    desc.textContent = card.desc;
    body.appendChild(desc);
    card.choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.className = "move-btn";
      btn.type = "button";
      btn.textContent = choice.label;
      btn.addEventListener("click", () => chooseChoiceForPlay(choice.key));
      body.appendChild(btn);
    });
  } else if (pp.step === "peek") {
    const desc = document.createElement("p");
    desc.textContent = "山札の上から見えたカードの中から1枚選んで引きます。";
    body.appendChild(desc);
    pp.peeked.forEach((cardId) => {
      const c = CARD_MAP[cardId];
      const btn = document.createElement("button");
      btn.className = "card-btn";
      btn.style.background = c.color;
      btn.type = "button";
      btn.innerHTML = `<span class="card-name">${c.name}</span><span class="card-desc">${c.desc}</span>`;
      btn.addEventListener("click", () => choosePeekForPlay(cardId));
      body.appendChild(btn);
    });
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "secondary-btn";
  cancelBtn.type = "button";
  cancelBtn.textContent = "キャンセル";
  cancelBtn.addEventListener("click", cancelPlayFlow);
  body.appendChild(cancelBtn);
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
    const tags = [];
    if (card.category === "attack") tags.push("攻撃");
    if (hasSub(card, "速攻")) tags.push("速攻");
    if (hasSub(card, "cha")) tags.push("cha");
    if (hasSub(card, "enc")) tags.push("enc");
    const tagText = tags.length ? ` [${tags.join("/")}]` : "";
    box.innerHTML = `<span class="card-name">${card.name}${tagText}</span><span class="card-desc">${card.desc}</span>`;
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

document.getElementById("cha-reveal-btn").addEventListener("click", revealChaResponse);
document.getElementById("cha-pass-btn").addEventListener("click", passChaResponse);

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
renderPlayerNameFields();
renderRulesModal();
showScreen("setup-screen");
