"use strict";

// ---------------------------------------------------------------------------
// カード定義
// ---------------------------------------------------------------------------
// 各カードは id/name/desc/color に加えて、以下を任意で持てる:
//   - category: "attack" ... 「攻撃」カード。対象プレイヤーへ不利な効果を与える
//   - sub: 副効果タグの配列。"速攻" / "cha" / "enc" を指定できる
//       速攻: 1ターン1枚の通常制限を無視して何枚でも使える
//       cha : 自分のターンでなくても、直前に場に出たカード(cha自身を含む)に
//             割り込んで使える。通常の手札クリックでは使えず、
//             cha発動チャンスでのみ使用可
//       enc : 他のカードと同時に使うことでそのカードに変化を与える。
//             1枚のカードに複数のencを添付でき、通常の手札クリックでは使えず、
//             他カード使用時の添付選択でのみ使用可
//   - needsTarget: true ... 使用時に対象プレイヤーを1人選ばせる
//   - choices: [{key,label}, ...] ... 使用時に選択肢を選ばせる
//   - peek: N ... 使用時に山札の上からN枚を見せて1枚選ばせる
//   - magnitude: 数値効果の基準値。encの倍率がかかった上でcontext.magnitudeになる
//   - encModify(context, count): enc カード専用。添付された枚数(count)を受け取り、
//     同時に使われたカードのcontextを書き換える
//   - chaCanRespond(pendingItem, responderIndex): cha カード専用(省略時は常に使用可)。
//     場の一番上にあるカードに対して今このカードで割り込めるかを返す
//   - chaResolve(stack, myIndex, actingPlayerIndex): cha カード専用。
//     スタック解決時に呼ばれ、stack[myIndex-1](自分が割り込んだ相手)に効果を及ぼす
//   - effect(state, playerIndex, context): 効果本体。ログに乗せる文字列を返す。
//     cha付きカードは持たない(cha専用の解決はchaResolveで行う)
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
      recordCountHistory(playerIndex);
      return `カウントが ${before} → ${state.count} に変化した!`;
    },
  },
  {
    id: "skip",
    name: "スキップ",
    desc: "(速攻)次のプレイヤーの番を1回とばす",
    color: "#9b59b6",
    sub: ["速攻"],
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
    id: "pass",
    name: "パス",
    desc: "カウントを進めずに自分のターンを終える(例: 上限60・現在59など、進めると必ず負けてしまう時に有効)",
    color: "#7f8c8d",
    effect(state, playerIndex) {
      state.turnEndedByPass = true;
      return `${state.players[playerIndex].name}がターンをパスした。カウントは${state.count}のまま。`;
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
      recordCountHistory(playerIndex);
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
    desc: "(速攻)山札の上から5枚を見て、その中から好きな1枚を引く",
    color: "#16a085",
    sub: ["速攻"],
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
      let targetIndex = context.targetIndex;
      if (targetIndex == null) {
        const others = state.players.map((_, i) => i).filter((i) => i !== playerIndex);
        targetIndex = others[Math.floor(Math.random() * others.length)];
      }
      const caster = state.players[playerIndex];
      const target = state.players[targetIndex];
      if (!target.hand.length) {
        return `${target.name}の手札は空だったので何も奪えなかった。`;
      }
      const stealIdx = Math.floor(Math.random() * target.hand.length);
      const stolenId = target.hand.splice(stealIdx, 1)[0];
      caster.hand.push(stolenId);
      return `${caster.name}が${target.name}から「${CARD_MAP[stolenId].name}」を奪った!`;
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
    desc: "直前に使われたカードの効果をもう一度発動する(コピー自身やcha・encのカードはコピーできない)",
    color: "#576574",
    effect(state, playerIndex) {
      const last = state.lastPlayedCard;
      if (!last || last.cardId === "copy_card") return "コピーできる効果がなかった。";
      const lastCard = CARD_MAP[last.cardId];
      if (hasSub(lastCard, "cha") || hasSub(lastCard, "enc")) {
        return "直前のカードはcha/encだったため、コピーできなかった。";
      }
      const msg = runCardEffect(lastCard, playerIndex, {});
      return `「${lastCard.name}」の効果をコピーした。${msg}`;
    },
  },
  {
    id: "cha_deny",
    name: "chaカード禁止",
    desc: "(cha)直前に場に出たカードの効果を打ち消す。打ち消しに打ち消しを使えば、無理やり通すこともできる",
    color: "#2c3e50",
    sub: ["cha"],
    chaResolve(stack, myIndex) {
      const target = stack[myIndex - 1];
      if (!target) return "打ち消す対象がなかった。";
      target.nullified = true;
      return `「${CARD_MAP[target.cardId].name}」の効果を打ち消した。`;
    },
  },
  {
    id: "cha_copy",
    name: "chaコピー",
    desc: "(cha)直前に場に出たカードの効果を自分にもコピーする(cha付きカードにも使える)",
    color: "#34495e",
    sub: ["cha"],
    chaResolve(stack, myIndex, actingPlayerIndex) {
      const target = stack[myIndex - 1];
      if (!target || target.nullified) return "コピーする対象がなかった。";
      const targetCard = CARD_MAP[target.cardId];
      if (hasSub(targetCard, "cha") && targetCard.chaResolve) {
        return targetCard.chaResolve(stack, myIndex - 1, actingPlayerIndex);
      }
      const msg = runCardEffect(targetCard, actingPlayerIndex, Object.assign({}, target.context));
      return `「${targetCard.name}」の効果を自分にもコピーした。${msg}`;
    },
  },
  {
    id: "reflection",
    name: "reflection",
    desc: "(cha)自分が「攻撃」カードの対象になった直後にだけ使え、その効果を発動者に跳ね返す",
    color: "#7f8fa6",
    sub: ["cha"],
    chaCanRespond(pendingItem, responderIndex) {
      const c = CARD_MAP[pendingItem.cardId];
      return c.category === "attack" && pendingItem.context.targetIndex === responderIndex;
    },
    chaResolve(stack, myIndex) {
      const target = stack[myIndex - 1];
      if (!target) return "跳ね返す対象がなかった。";
      const targetCard = CARD_MAP[target.cardId];
      if (targetCard.category !== "attack") return "攻撃カードではなかったため何も起きなかった。";
      const oldCaster = target.playerIndex;
      const oldTarget = target.context.targetIndex;
      target.playerIndex = oldTarget;
      target.context.targetIndex = oldCaster;
      return `「${targetCard.name}」の効果を跳ね返した!`;
    },
  },
  {
    id: "up_grade",
    name: "up grade",
    desc: "(enc)同時に使ったカードの数値効果を変化させる(1枚添付で1.5倍、2枚以上は添付した枚数倍。小数点切り捨て)",
    color: "#d35400",
    sub: ["enc"],
    encModify(context, count) {
      const factor = count === 1 ? 1.5 : count;
      context.encMultiply = (context.encMultiply || 1) * factor;
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

// カードイラスト表示規約: assets/cards/<id>.png → assets/cards/<id>.svg の順で探し、
// 見つかった方をサムネイルとして表示する(PNGを優先することで、後から本物のイラストを
// 同じidのPNGとして置くだけでSVGの仮絵を上書きできる=差し替えが容易)。
// どちらも無い/読み込みに失敗した場合は静かに諦めて、従来通り色背景のみの見た目に
// フォールバックする。
function buildCardVisual(cardId) {
  const visual = document.createElement("div");
  visual.className = "card-visual";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  const candidates = [`assets/cards/${cardId}.png`, `assets/cards/${cardId}.svg`];
  let nextIndex = 0;
  const tryNext = () => {
    if (nextIndex >= candidates.length) {
      visual.remove();
      return;
    }
    img.src = candidates[nextIndex++];
  };
  img.addEventListener("error", tryNext);
  visual.appendChild(img);
  tryNext();
  return visual;
}

// card-btn を使う箇所(手札・cha応答・enc選択・山札プレビュー・ルール一覧)共通の中身
function buildCardBody(card, tagText) {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildCardVisual(card.id));
  const name = document.createElement("span");
  name.className = "card-name";
  name.textContent = `${card.name}${tagText || ""}`;
  const desc = document.createElement("span");
  desc.className = "card-desc";
  desc.textContent = card.desc;
  frag.appendChild(name);
  frag.appendChild(desc);
  return frag;
}

// カード使用時の一瞬の演出。クリックしたボタンにアニメーションをかけてから実処理(onDone)を
// 呼ぶ。演出中はボタンを無効化し、連打による二重発動を防ぐ。
function triggerCardPlayAnimation(btn, onDone) {
  btn.disabled = true;
  btn.classList.add("card-playing");
  setTimeout(onDone, 200);
}

// 同じ要素でCSSアニメーションを再トリガーするヘルパー(一度クラスを外して
// 強制リフローしてから付け直す)
function pulseElement(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
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

// enc カードが「速攻」を付与するかどうかを、実際にencModifyを試し撃ちして判定する
// (idをハードコードせず、今後 forceSpeed を使う enc カードが増えても自動的に対応できるように)
function encGrantsSpeed(encCard) {
  if (!encCard.encModify) return false;
  const testContext = {};
  encCard.encModify(testContext, 1);
  return testContext.forceSpeed === true;
}

// ---------------------------------------------------------------------------
// ゲーム状態
// ---------------------------------------------------------------------------
let state = null;
let lastRenderedCount = null;

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
    advanceMultiplier: 1,
    isNPC: !!(config.isNPC && config.isNPC[i]),
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
    turnEndedByPass: false,
    lastPlayedCard: null,
    pendingPlay: null,
    chaStack: null,
    chaQueue: null,
    chaCurrentResponder: null,
    chaAnyRevealed: false,
    log: [],
    countHistory: [{ index: 0, count: 0, playerIndex: null }],
  };
}

// カウントの推移グラフ用の記録。state.count を意図的に変更する箇所(advanceCount、
// タイムトリック、強くてニューゲームなど)から、変更後に呼び出す。
function recordCountHistory(playerIndex) {
  state.countHistory.push({
    index: state.countHistory.length,
    count: state.count,
    playerIndex,
  });
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

// カードが「今この瞬間の自分の手札からは使えない」理由を返す(使えるなら null)。
// 使えないカードは例外なくここで検出し、手札ではボタンを disabled にして表示する。
function cardUnavailableReason(card, hand, index) {
  if (hasSub(card, "cha")) {
    return "相手(または自分)がカードを場に出した直後にのみ、割り込んで使えるカードです。";
  }
  if (hasSub(card, "enc")) {
    return "他のカードを使う時に、同時に添付してのみ使えるカードです。";
  }
  if (!hasSub(card, "速攻") && state.cardsPlayedThisTurn > 0) {
    const hasSpeedRescue = hand.some(
      (id, i) => i !== index && hasSub(CARD_MAP[id], "enc") && encGrantsSpeed(CARD_MAP[id])
    );
    if (!hasSpeedRescue) {
      return "このターンはすでに通常カードを使用済みです(speed upを同時に添付すれば使えます)。";
    }
  }
  return null;
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
  if (!card || cardUnavailableReason(card, player.hand, handIndex)) return;
  state.pendingPlay = {
    handIndex,
    cardId,
    encSelected: [],
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

function toggleEncForPlay(encIndex) {
  const pp = state.pendingPlay;
  const i = pp.encSelected.indexOf(encIndex);
  if (i === -1) pp.encSelected.push(encIndex);
  else pp.encSelected.splice(i, 1);
  render();
}

function confirmEncForPlay() {
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

// 添付されたencカード群(同一idはまとめて枚数を渡す)をcontextに反映する
function applyEncAttachments(encCards, context) {
  const counts = {};
  for (const c of encCards) counts[c.id] = (counts[c.id] || 0) + 1;
  const applied = new Set();
  for (const c of encCards) {
    if (applied.has(c.id)) continue;
    applied.add(c.id);
    if (c.encModify) c.encModify(context, counts[c.id]);
  }
}

function resolvePlayFlow() {
  const pp = state.pendingPlay;
  const player = state.players[state.currentPlayerIndex];
  const card = CARD_MAP[pp.cardId];

  const context = {};
  if (pp.targetIndex != null) context.targetIndex = pp.targetIndex;
  if (pp.choice != null) context.choice = pp.choice;
  if (pp.peeked != null) context.peeked = pp.peeked.slice();

  const encCards = pp.encSelected.map((idx) => CARD_MAP[player.hand[idx]]);
  applyEncAttachments(encCards, context);

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

  const indexesToRemove = [pp.handIndex, ...pp.encSelected];
  indexesToRemove.sort((a, b) => b - a);
  for (const idx of indexesToRemove) {
    const removedId = player.hand.splice(idx, 1)[0];
    moveToGraveyard(removedId);
  }

  if (!isSpeedy) state.cardsPlayedThisTurn += 1;

  state.pendingPlay = null;
  beginChaPhase(card, state.currentPlayerIndex, context);
}

// ---------------------------------------------------------------------------
// chaスタック: 場に出たカードに、cha付きカードで何度でも割り込める優先権システム。
// 「chaカード禁止にchaカード禁止を使って無理やり通す」のような多重割り込みに
// 対応するため、場札を配列(スタック)として扱い、最後に積まれたものへの割り込みを
// 手番順に確認 → 誰も割り込まなくなったら、積まれた順とは逆(後入れ先出し)に解決する。
// cha付きカードを持っていない/割り込めるカードがないプレイヤーは、目隠し画面を
// 出さず黙ってスキップする。
// ---------------------------------------------------------------------------
function buildResponseQueue(fromIndex) {
  const queue = [];
  let idx = fromIndex;
  for (let i = 0; i < state.players.length - 1; i++) {
    idx = nextIndex(idx);
    queue.push(idx);
  }
  return queue;
}

function eligibleChaCards(responder, pendingItem) {
  const player = state.players[responder];
  return player.hand
    .map((id, idx) => ({ idx, card: CARD_MAP[id] }))
    .filter(({ card }) => hasSub(card, "cha"))
    .filter(({ card }) => !card.chaCanRespond || card.chaCanRespond(pendingItem, responder));
}

function beginChaPhase(card, playerIndex, context) {
  state.chaStack = [{ cardId: card.id, playerIndex, context, nullified: false }];
  state.chaQueue = buildResponseQueue(playerIndex);
  state.chaAnyRevealed = false;
  advanceChaBuilding();
}

function advanceChaBuilding() {
  while (state.chaQueue.length) {
    const responder = state.chaQueue[0];
    if (state.players[responder].isNPC) {
      // NPCはまだcha割り込みの判断を持たない(常にパス扱い)。判断ロジックが
      // 増えたらここで npcDecideChaResponse 相当を呼ぶ形に置き換える。
      state.chaQueue.shift();
      continue;
    }
    const hasAnyChaCard = state.players[responder].hand.some((id) => hasSub(CARD_MAP[id], "cha"));
    if (!hasAnyChaCard) {
      state.chaQueue.shift();
      continue;
    }
    state.chaCurrentResponder = responder;
    showChaTransitionScreen(responder);
    return;
  }
  resolveChaStack();
}

function showChaTransitionScreen(responder) {
  state.chaAnyRevealed = true;
  const player = state.players[responder];
  document.getElementById("cha-transition-player-name").textContent = player.name;
  showScreen("cha-transition-screen");
}

function revealChaResponse() {
  showScreen("cha-response-screen");
  renderChaResponseScreen();
}

function renderChaResponseScreen() {
  const responder = state.chaCurrentResponder;
  const player = state.players[responder];
  const top = state.chaStack[state.chaStack.length - 1];
  const topCard = CARD_MAP[top.cardId];

  document.getElementById("cha-response-player-name").textContent = player.name;
  document.getElementById("cha-response-host-card").textContent =
    `${state.players[top.playerIndex].name}が「${topCard.name}」を使用!割り込みますか?`;

  const area = document.getElementById("cha-response-cards");
  area.innerHTML = "";
  let shown = 0;
  player.hand.forEach((cardId, idx) => {
    const c = CARD_MAP[cardId];
    if (!hasSub(c, "cha")) return;
    const usable = !c.chaCanRespond || c.chaCanRespond(top, responder);
    const btn = document.createElement("button");
    btn.className = "card-btn";
    btn.style.background = c.color;
    btn.style.animationDelay = `${shown * 40}ms`;
    shown++;
    btn.type = "button";
    btn.appendChild(buildCardBody(c));
    if (usable) {
      btn.addEventListener("click", () => triggerCardPlayAnimation(btn, () => playChaResponse(idx)));
    } else {
      btn.disabled = true;
      btn.title = "今の場札には割り込めません。";
    }
    area.appendChild(btn);
  });
}

function playChaResponse(handIndex) {
  const responder = state.chaCurrentResponder;
  const player = state.players[responder];
  const cardId = player.hand.splice(handIndex, 1)[0];
  moveToGraveyard(cardId);
  state.chaStack.push({ cardId, playerIndex: responder, context: {}, nullified: false });
  addLog(`${player.name}が「${CARD_MAP[cardId].name}」で割り込んだ!`, true);
  // 新しく場札が積まれたので、その1枚に対する割り込みチャンスを全員分やり直す
  state.chaQueue = buildResponseQueue(responder);
  advanceChaBuilding();
}

function passChaResponse() {
  state.chaQueue.shift();
  state.chaCurrentResponder = null;
  advanceChaBuilding();
}

function resolveChaStack() {
  const stack = state.chaStack;
  const originalHostIndex = stack[0].playerIndex;

  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    const card = CARD_MAP[item.cardId];
    if (item.nullified) {
      addLog(`「${card.name}」の効果は打ち消されて発動しなかった。`, true);
      continue;
    }
    if (hasSub(card, "cha") && card.chaResolve) {
      const msg = card.chaResolve(stack, i, item.playerIndex);
      if (msg) addLog(`${state.players[item.playerIndex].name}の「${card.name}」: ${msg}`, true);
    } else if (!hasSub(card, "cha")) {
      const msg = runCardEffect(card, item.playerIndex, item.context);
      addLog(`${state.players[item.playerIndex].name}が「${card.name}」を使った。${msg}`);
    }
  }

  state.lastPlayedCard = { cardId: stack[0].cardId, playerIndex: stack[0].playerIndex };
  const wasRevealed = state.chaAnyRevealed;
  state.chaStack = null;
  state.chaQueue = null;
  state.chaCurrentResponder = null;
  state.chaAnyRevealed = false;

  if (state.turnEndedByPass) {
    state.turnEndedByPass = false;
    endTurnAndAdvance();
    return;
  }

  if (wasRevealed) {
    if (state.players[originalHostIndex].isNPC) {
      // cha解決を待つ間に人間側の画面が表示されていたはずなので、NPCの続きの手番を再開する
      render();
      setTimeout(() => runNpcTurn(originalHostIndex), 450);
    } else {
      document.getElementById("transition-player-name").textContent = state.players[originalHostIndex].name;
      showScreen("transition-screen");
    }
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
  recordCountHistory(state.currentPlayerIndex);

  const nums =
    amount === 1
      ? `${newCount}`
      : `${state.count - amount + 1}〜${newCount}`;
  addLog(`${player.name} が「${nums}」と言った。(残り${state.limit - newCount})`);

  if (newCount >= state.limit) {
    if (player.safeguard) {
      player.safeguard = false;
      state.count = 0;
      recordCountHistory(state.currentPlayerIndex);
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
  if (state.players[next].isNPC) {
    showNpcTurnScreen(next);
  } else {
    showTransitionScreen();
  }
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

// ---------------------------------------------------------------------------
// NPC(コンピュータ操作のプレイヤー)
// ---------------------------------------------------------------------------
// NPCの手番は目隠しが不要なので専用の npc-turn-screen を出し、少し間を置いてから
// 自動でカードを使ったりカウントを進めたりする。判断ロジックは単純なルールベース
// (探索や学習は行わない)。実際の状態変更は人間の操作と同じ関数
// (resolvePlayFlow/advanceCount 等)を通すことで、既存のcha/enc/グラフ記録などの
// 仕組みをそのまま利用する。
function showNpcTurnScreen(playerIndex) {
  const player = state.players[playerIndex];
  document.getElementById("npc-turn-player-name").textContent = player.name;
  showScreen("npc-turn-screen");
  setTimeout(() => runNpcTurn(playerIndex), 500);
}

// このターンに使うカードを選ぶ(手札インデックスを返す。使わないならnull)。
// 速攻は積極的に、通常カードはほどほどの確率で使う程度の単純な判断。
function npcChooseCardToPlay(playerIndex) {
  const player = state.players[playerIndex];
  const eligible = player.hand
    .map((id, idx) => ({ idx, card: CARD_MAP[id] }))
    .filter(({ card, idx }) => isDirectlyPlayable(card) && !cardUnavailableReason(card, player.hand, idx));
  if (!eligible.length) return null;

  const speedy = eligible.filter(({ card }) => hasSub(card, "速攻"));
  if (speedy.length && Math.random() < 0.7) {
    return speedy[Math.floor(Math.random() * speedy.length)].idx;
  }
  const normal = eligible.filter(({ card }) => !hasSub(card, "速攻"));
  if (normal.length && Math.random() < 0.5) {
    return normal[Math.floor(Math.random() * normal.length)].idx;
  }
  return null;
}

// 攻撃カードの対象: 手札が一番多い相手を狙う(同数ならその中からランダム)
function npcChooseTarget(playerIndex) {
  const others = state.players.map((_, i) => i).filter((i) => i !== playerIndex);
  const maxHand = Math.max(...others.map((i) => state.players[i].hand.length));
  const candidates = others.filter((i) => state.players[i].hand.length === maxHand);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// 選択肢カードの判断(タイムトリックは上限までの余裕で+5/-5を選ぶ。それ以外はランダム)
function npcChooseChoice(card) {
  if (card.id === "time_trick") {
    return state.limit - state.count <= 10 ? "minus" : "plus";
  }
  return card.choices[Math.floor(Math.random() * card.choices.length)].key;
}

// 山札を見て選ぶカード(choose): 単純に先頭の1枚を選ぶ
function npcChoosePeek(peeked) {
  return peeked[0];
}

// カウントの前進量: 最大値ぎりぎりは避けつつ、それなりの数を選ぶ
function npcChooseAdvanceAmount() {
  const maxAdvance = Math.min(effectiveMaxAdvance(), state.limit - state.count);
  if (maxAdvance <= 1) return Math.max(1, maxAdvance);
  const safeMax = maxAdvance - 1;
  return 1 + Math.floor(Math.random() * safeMax);
}

// 人間の手札クリック(beginCardPlay)を経由せず、state.pendingPlay を直接組み立てて
// resolvePlayFlow に渡す。モーダルを表示しないだけで、解決ロジックは完全に共通。
function npcPlayCard(playerIndex, handIndex) {
  const player = state.players[playerIndex];
  const cardId = player.hand[handIndex];
  const card = CARD_MAP[cardId];

  const pendingPlay = {
    handIndex,
    cardId,
    encSelected: [], // NPCは現時点でencを添付しない
    encAsked: true,
    targetIndex: card.needsTarget ? npcChooseTarget(playerIndex) : null,
    choice: card.choices ? npcChooseChoice(card) : null,
    peeked: null,
    peekDone: true,
    step: null,
  };

  if (card.peek) {
    const peeked = [];
    for (let i = 0; i < card.peek; i++) {
      const c = state.deck.pop();
      if (c) peeked.push(c);
    }
    pendingPlay.peeked = peeked;
    if (peeked.length) pendingPlay.choice = npcChoosePeek(peeked);
  }

  state.pendingPlay = pendingPlay;
  resolvePlayFlow();
}

// NPCの手番のメインループ。1枚使うたびに少し待ってから次を判断する。
// - cha解決が人間の応答待ちで中断した場合(state.chaStackが残る)は、resolveChaStack側が
//   後で runNpcTurn を呼び直して再開する
// - 「パス」カードなどでターンが既に終わっている場合(currentPlayerIndexが変わっている)は
//   何もしない
function runNpcTurn(playerIndex) {
  if (!state || state.currentPlayerIndex !== playerIndex) return;

  const handIndex = npcChooseCardToPlay(playerIndex);
  if (handIndex != null) {
    npcPlayCard(playerIndex, handIndex);
    if (state.chaStack) return;
    if (!state || state.currentPlayerIndex !== playerIndex) return;
    setTimeout(() => runNpcTurn(playerIndex), 450);
    return;
  }

  const amount = npcChooseAdvanceAmount();
  advanceCount(amount);
}

// ---------------------------------------------------------------------------
// カウント推移グラフ(ライブラリは使わずSVGを直接組み立てる)
// ---------------------------------------------------------------------------
// プレイヤーごとの識別色(最大6人分。ダークテーマ向けに検証済みのカテゴリカル配色を
// 固定順で割り当てる。4番目の緑は背景とのコントラストが低めなので、凡例と
// ツールチップの文字ラベルで補っている=色だけに意味を持たせない)
const PLAYER_CHART_COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767"];

function hideChartTooltip() {
  document.getElementById("count-chart-tooltip").hidden = true;
}

function showChartTooltip(anchorEl, text) {
  const wrap = document.getElementById("count-chart-wrap");
  const tip = document.getElementById("count-chart-tooltip");
  const wrapRect = wrap.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = `${anchorRect.left - wrapRect.left + anchorRect.width / 2}px`;
  tip.style.top = `${anchorRect.top - wrapRect.top}px`;
}

function renderChartLegend() {
  const legend = document.getElementById("count-chart-legend");
  legend.innerHTML = "";
  state.players.forEach((p, i) => {
    const item = document.createElement("span");
    item.className = "chart-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "chart-legend-swatch";
    swatch.style.background = PLAYER_CHART_COLORS[i % PLAYER_CHART_COLORS.length];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(p.name));
    legend.appendChild(item);
  });
}

function renderCountChart() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("count-chart");
  svg.innerHTML = "";
  hideChartTooltip();
  renderChartLegend();

  const wrap = document.getElementById("count-chart-wrap");
  const width = Math.max(280, wrap.clientWidth - 16);
  const height = 160;
  const padLeft = 28;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 8;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const history = state.countHistory;
  const limit = state.limit;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxIndex = Math.max(1, history.length - 1);

  const xOf = (i) => padLeft + (plotW * i) / maxIndex;
  const yOf = (count) => padTop + plotH - (plotH * Math.min(count, limit)) / limit;

  // 目盛り線(0 / 上限の半分 / 上限)
  [0, limit / 2, limit].forEach((v) => {
    const y = yOf(v);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("class", "chart-grid-line");
    line.setAttribute("x1", padLeft);
    line.setAttribute("x2", width - padRight);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("class", "chart-axis-label");
    label.setAttribute("x", 2);
    label.setAttribute("y", y + 3);
    label.textContent = Math.round(v);
    svg.appendChild(label);
  });

  // 上限ライン(点線・危険ラインとして常に表示)
  const limitY = yOf(limit);
  const limitLine = document.createElementNS(svgNS, "line");
  limitLine.setAttribute("class", "chart-limit-line");
  limitLine.setAttribute("x1", padLeft);
  limitLine.setAttribute("x2", width - padRight);
  limitLine.setAttribute("y1", limitY);
  limitLine.setAttribute("y2", limitY);
  svg.appendChild(limitLine);

  const limitLabel = document.createElementNS(svgNS, "text");
  limitLabel.setAttribute("class", "chart-limit-label");
  limitLabel.setAttribute("x", width - padRight);
  limitLabel.setAttribute("y", limitY - 4);
  limitLabel.setAttribute("text-anchor", "end");
  limitLabel.textContent = `上限 ${limit}`;
  svg.appendChild(limitLabel);

  if (history.length < 2) {
    return; // まだ1手も進んでいない: 線・点は無しでグリッドだけ表示
  }

  const points = history.map((h) => [xOf(h.index), yOf(h.count)]);

  const line = document.createElementNS(svgNS, "polyline");
  line.setAttribute("class", "chart-line");
  line.setAttribute("points", points.map((p) => p.join(",")).join(" "));
  svg.appendChild(line);

  const baseline = padTop + plotH;
  const area = document.createElementNS(svgNS, "polygon");
  area.setAttribute("class", "chart-area");
  area.setAttribute(
    "points",
    `${points[0][0]},${baseline} ${points.map((p) => p.join(",")).join(" ")} ${points[points.length - 1][0]},${baseline}`
  );
  svg.appendChild(area);

  // 各点(起点=index0は誰の手番でもないので打たない)。ホバーでプレイヤー名と数値を表示
  history.forEach((h, i) => {
    if (h.playerIndex == null) return;
    const [x, y] = points[i];
    const color = PLAYER_CHART_COLORS[h.playerIndex % PLAYER_CHART_COLORS.length];
    const player = state.players[h.playerIndex];
    const isLast = i === history.length - 1;

    const hit = document.createElementNS(svgNS, "circle");
    hit.setAttribute("class", "chart-point-hit");
    hit.setAttribute("cx", x);
    hit.setAttribute("cy", y);
    hit.setAttribute("r", 10);
    hit.addEventListener("mouseenter", () => showChartTooltip(hit, `${player.name}: ${h.count}`));
    hit.addEventListener("mouseleave", hideChartTooltip);
    svg.appendChild(hit);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("class", "chart-point");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", isLast ? 5 : 4);
    dot.setAttribute("fill", color);
    svg.appendChild(dot);
  });

  // 直近の値だけ直接ラベル表示(全点にラベルを付けると煩雑になるため)
  const last = points[points.length - 1];
  const nearRightEdge = last[0] + 8 > width - padRight - 4;
  const lastValue = document.createElementNS(svgNS, "text");
  lastValue.setAttribute("class", "chart-point-value");
  lastValue.setAttribute("x", nearRightEdge ? last[0] - 8 : last[0] + 8);
  lastValue.setAttribute("y", last[1] - 8);
  lastValue.setAttribute("text-anchor", nearRightEdge ? "end" : "start");
  lastValue.textContent = history[history.length - 1].count;
  svg.appendChild(lastValue);
}

function render() {
  const player = state.players[state.currentPlayerIndex];

  const countEl = document.getElementById("current-count");
  if (lastRenderedCount !== null && lastRenderedCount !== state.count) {
    pulseElement(countEl, "count-pulse");
  }
  countEl.textContent = state.count;
  lastRenderedCount = state.count;
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
    chip.textContent = `${p.name} (手札${p.hand.length}${p.safeguard ? " 🛡" : ""}${p.isNPC ? " 🤖" : ""})`;
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
      btn.style.animationDelay = `${idx * 40}ms`;
      btn.type = "button";
      const tag =
        card.category === "attack" ? " [攻撃]" :
        hasSub(card, "enc") ? " [enc]" :
        hasSub(card, "cha") ? " [cha]" :
        hasSub(card, "速攻") ? " [速攻]" : "";
      btn.appendChild(buildCardBody(card, tag));
      const reason = cardUnavailableReason(card, player.hand, idx);
      if (reason) {
        btn.disabled = true;
        btn.title = reason;
      } else {
        btn.addEventListener("click", () => triggerCardPlayAnimation(btn, () => beginCardPlay(idx)));
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

  renderCountChart();
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
    desc.textContent = "同時に使う enc カードを選べます(複数選択可・選ばなくてもOK)。";
    body.appendChild(desc);
    eligibleEncIndexes().forEach((idx, i) => {
      const c = CARD_MAP[state.players[state.currentPlayerIndex].hand[idx]];
      const selected = pp.encSelected.includes(idx);
      const btn = document.createElement("button");
      btn.className = "card-btn" + (selected ? " card-btn-selected" : "");
      btn.style.background = c.color;
      btn.style.animationDelay = `${i * 40}ms`;
      btn.type = "button";
      btn.appendChild(buildCardBody(c, selected ? " ✓選択中" : ""));
      btn.addEventListener("click", () => toggleEncForPlay(idx));
      body.appendChild(btn);
    });
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary-btn";
    confirmBtn.type = "button";
    confirmBtn.textContent = pp.encSelected.length ? `${pp.encSelected.length}枚つけて使う` : "つけずに使う";
    confirmBtn.addEventListener("click", confirmEncForPlay);
    body.appendChild(confirmBtn);
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
    pp.peeked.forEach((cardId, i) => {
      const c = CARD_MAP[cardId];
      const btn = document.createElement("button");
      btn.className = "card-btn";
      btn.style.background = c.color;
      btn.style.animationDelay = `${i * 40}ms`;
      btn.type = "button";
      btn.appendChild(buildCardBody(c));
      btn.addEventListener("click", () => triggerCardPlayAnimation(btn, () => choosePeekForPlay(cardId)));
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

    const npcLabel = document.createElement("label");
    npcLabel.className = "npc-toggle";
    const npcCheckbox = document.createElement("input");
    npcCheckbox.type = "checkbox";
    npcCheckbox.id = `player-npc-${i}`;
    npcLabel.appendChild(npcCheckbox);
    npcLabel.appendChild(document.createTextNode("NPC"));
    row.appendChild(npcLabel);

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
  const isNPC = [];
  for (let i = 0; i < playerCount; i++) {
    const input = document.getElementById(`player-name-${i}`);
    playerNames.push(input && input.value.trim() ? input.value.trim() : "");
    const npcCheckbox = document.getElementById(`player-npc-${i}`);
    isNPC.push(!!(npcCheckbox && npcCheckbox.checked));
  }

  state = createGame({ playerNames, limit, maxAdvance, handSize, deckCopies, isNPC });
  lastRenderedCount = null;
  startTurn(0);
  addLog(`ゲーム開始!上限${state.limit} / 最大カウント${state.baseMaxAdvance}`, true);
  if (state.players[0].isNPC) {
    showNpcTurnScreen(0);
  } else {
    showTransitionScreen();
  }
}

// ---------------------------------------------------------------------------
// ルールモーダル
// ---------------------------------------------------------------------------
function renderRulesModal() {
  const list = document.getElementById("rules-card-list");
  list.innerHTML = "";
  CARD_TYPES.forEach((card, i) => {
    const box = document.createElement("div");
    box.className = "card-btn";
    box.style.background = card.color;
    box.style.animationDelay = `${i * 20}ms`;
    const tags = [];
    if (card.category === "attack") tags.push("攻撃");
    if (hasSub(card, "速攻")) tags.push("速攻");
    if (hasSub(card, "cha")) tags.push("cha");
    if (hasSub(card, "enc")) tags.push("enc");
    const tagText = tags.length ? ` [${tags.join("/")}]` : "";
    box.appendChild(buildCardBody(card, tagText));
    list.appendChild(box);
  });
}

// ---------------------------------------------------------------------------
// 動作確認ツール(URLに ?debug を付けた時だけ表示。新しいカードを実際に手札に
// 入れて挙動を確かめられる。詳しくは CARD_GUIDE.md を参照)
// ---------------------------------------------------------------------------
const DEBUG_MODE = new URLSearchParams(location.search).has("debug");

function setupDebugPanel() {
  const panel = document.getElementById("debug-panel");
  panel.hidden = !DEBUG_MODE;
  if (!DEBUG_MODE) return;

  const select = document.getElementById("debug-card-select");
  CARD_TYPES.forEach((card) => {
    const opt = document.createElement("option");
    opt.value = card.id;
    opt.textContent = `${card.name} (${card.id})`;
    select.appendChild(opt);
  });
}

function debugGiveSelectedCard() {
  if (!state) return;
  const cardId = document.getElementById("debug-card-select").value;
  if (!cardId || !CARD_MAP[cardId]) return;
  const player = state.players[state.currentPlayerIndex];
  player.hand.push(cardId);
  addLog(`[動作確認] ${player.name}の手札に「${CARD_MAP[cardId].name}」を追加した。`, true);
  render();
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

document.getElementById("debug-give-card-btn").addEventListener("click", debugGiveSelectedCard);

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
renderPlayerNameFields();
renderRulesModal();
setupDebugPanel();
showScreen("setup-screen");
