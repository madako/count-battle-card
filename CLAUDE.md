# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

カウントバトル (Count Battle) — a browser-based, hot-seat multiplayer variant of the counting game "Thirty" (like the classic "31 game"), with strategy cards added. Pure HTML/CSS/JS, no build step, no dependencies, no package.json. The whole app is 3 files: `index.html` (structure), `style.css` (dark-themed styling), `game.js` (all logic, state, and rendering).

UI text, comments, and commit-facing content in this repo are in Japanese; match that style when editing existing strings.

## Running / testing

There is no build, lint, or test tooling. To run the game, just open `index.html` directly in a browser (Chrome/Edge), or serve the directory statically, e.g.:

```
python3 -m http.server 8000
```

Verify changes manually in a browser — set up a game (2–6 players), play a few turns using cards and count advances, and check the transition/result screens.

## Architecture

`game.js` is a single script with no modules/bundler, loaded directly by `index.html`. It follows a simple pattern: one global mutable `state` object, pure-ish functions that mutate it, and a `render()` that redraws the DOM from `state` after each action. There is no virtual DOM or framework — every `render()` call clears and rebuilds the relevant containers (`hand-area`, `move-area`, `players-overview`, `log-area`, etc.) from scratch via `innerHTML`/`createElement`.

### Card definitions

`CARD_TYPES` is the extension point for adding/tuning cards; `CARD_MAP` is the id-keyed lookup built from it. Each entry has `id`, `name`, `desc`, `color`, and optionally:

- `category: "attack"` — an attack card; see below.
- `sub: ["速攻" | "cha" | "enc"]` — sub-effect tags (a card may have at most one in practice, but the field is an array).
- `needsTarget: true` — prompts for a target player before resolving.
- `choices: [{key, label}, ...]` — prompts the player to pick one before resolving (e.g. タイムトリック's +5/-5).
- `peek: N` — pops N cards off the deck and lets the player pick one before resolving (e.g. choose).
- `magnitude: N` — the card's numeric "strength"; `runCardEffect()` computes `context.magnitude` from it (scaled by any enc multiplier) before calling `effect`.
- `encModify(context, count)` — enc-only. `count` is how many copies of *this specific* enc card were attached in the same play (deduped by id, see `applyEncAttachments`), so multi-copy scaling like up_grade's "1 copy = 1.5×, 2+ copies = N×" can be expressed without compounding. Mutates the shared `context` (`up_grade` sets `context.encMultiply`, `speed_up` sets `context.forceSpeed`).
- `chaCanRespond(pendingItem, responderIndex)` — cha-only, optional (default: always respondable). Gates whether this card can be played against the current top of the cha stack; `reflection` uses this to only allow itself when `pendingItem` is an `attack` card whose `context.targetIndex === responderIndex`.
- `chaResolve(stack, myIndex, actingPlayerIndex)` — cha-only, required for cha cards (they have no `effect`). Called during stack resolution; acts on `stack[myIndex - 1]` (whatever this card was played in response to) — e.g. `cha_deny` sets its `.nullified = true`, `reflection` swaps its `playerIndex`/`context.targetIndex`, `cha_copy` re-invokes the target's own resolution (recursing into `chaResolve` if the target is itself a cha card, otherwise calling `runCardEffect`).
- `effect(state, playerIndex, context)` — mutates `state` and returns a log message. Cards with `sub: ["cha"]` never have this (they resolve via `chaResolve` instead). Always invoked through `runCardEffect(card, playerIndex, context)`, never called directly, so `magnitude` is computed consistently everywhere (normal play, `chaコピー`, and `copy_card`'s replay). Effects that read `context.targetIndex`/`context.choice`/`context.peeked` should default sensibly when they're missing, since `copy_card` calls `effect` with a bare `{}`.

Cards tagged `enc` or `cha` are **not directly clickable** in the hand — `cardUnavailableReason()` is the single source of truth for "can this card be used right now," covering enc/cha-lock, *and* the per-turn cap (a normal card is disabled unless a `speed_up`-equivalent enc card — detected generically via `encGrantsSpeed()`, not by id — is available to rescue it). Anything `cardUnavailableReason()` flags gets a real `disabled` button with an explanatory `title`, never a clickable-but-silently-rejected one; keep new unavailability logic funneled through that one function so hand rendering and future eligibility checks can't drift apart.

### Turn flow and the card-play pipeline

`startTurn(playerIndex)` resets per-turn bonuses/caps/`cardsPlayedThisTurn`. Playing a directly-playable card from the hand goes through a multi-step pipeline rather than resolving immediately:

1. `beginCardPlay(handIndex)` opens `state.pendingPlay` and calls `advancePlayFlow()`, which walks through whichever steps the card needs — `enc` (toggle any number of eligible enc cards from hand via `toggleEncForPlay`, then `confirmEncForPlay`) → `target` (if `needsTarget`) → `choice` (if `choices`) → `peek` (if `peek`) — rendering `#play-modal` (via `renderPlayModal()`) at each step. This all happens on the acting player's own screen, no hidden info involved, so no blind transition is needed here. `cancelPlayFlow()` aborts and returns any peeked cards to the deck.
2. `resolvePlayFlow()` applies every selected enc card's `encModify` (via `applyEncAttachments`, which computes per-id counts first), then checks the per-turn cap (`state.cardsPlayedThisTurn`) — normal cards are rejected (and stay in hand) if a non-speedy card was already played this turn; `sub: ["速攻"]` or an attached `speed_up`-equivalent bypasses this. On success, the host card and all attached enc cards move from hand to `state.graveyard`, then `beginChaPhase()` starts.
3. Card resolution is a **stack** (`state.chaStack`), not a single fixed host — this is what lets `chaカード禁止` be answered with another `chaカード禁止` (nullifying the nullifier forces the original card through) or `chaコピー` target another cha card. `beginChaPhase(card, playerIndex, context)` pushes the host as `stack[0]` and calls `advanceChaBuilding()`, which offers each *other* player, in turn order (`buildResponseQueue`), the chance to push a `cha`-tagged card on top (`playChaResponse`) or pass (`passChaResponse`); every push restarts the round (`buildResponseQueue` again, now excluding the pusher) so anyone — including the original host — can respond to the new top. Players with zero `cha`-tagged cards are skipped silently (no screen shown); anyone who *is* shown the screen sees every cha card they hold, with `chaCanRespond`-ineligible ones rendered disabled rather than hidden. `state.chaAnyRevealed` is set the moment any cha screen is actually shown — **do not** infer "was anything shown" from `stack.length`, since a revealed player can still choose to pass without pushing anything (this was a real bug: inferring it from stack length left the game stuck on `cha-response-screen` whenever the sole responder passed).
4. `resolveChaStack()` walks the stack **top to bottom** (LIFO): a `nullified` item is logged and skipped entirely (its own `chaResolve` never runs, which is how "denying a denial" lets the original card through); a cha item calls its `chaResolve`; anything else resolves via `runCardEffect`. `state.lastPlayedCard` is set from `stack[0]` *after* the loop (so reflection-driven `playerIndex` swaps on the host are reflected). Turn ownership for the post-phase transition, however, is captured *before* the loop (`originalHostIndex`) — reflection changes who the effect applies to, not whose turn it is. If `state.turnEndedByPass` was set (by the `pass` card's effect), `endTurnAndAdvance()` runs instead of the normal "resume the acting player" transition.

After all that, the player can still act again (more 速攻 cards, or `advanceCount(amount)`), same as before: `advanceCount` checks the loss condition and calls `endTurnAndAdvance()`, which computes the next player (honoring `direction`/`skipNext`) and shows the normal `transition-screen`.

### State fields worth knowing

- `pendingForcedCap` (set by `forced_number`, consumed in `startTurn`) vs `turnAdvanceBonus` (current-turn-only bonus, e.g. `count_boost`/`dash`) vs `player.advanceMultiplier` (persists across turns for that player only, e.g. `new_game`'s self-only doubling) — `effectiveMaxAdvance()` combines all three.
- `state.graveyard` — every card that's ever played (host, enc, or cha) lands here; `grave_robber`/`copy_card`-style cards read from it or from `state.lastPlayedCard`. `copy_card` explicitly refuses to copy anything tagged `cha`/`enc` (defensive — `lastPlayedCard` can currently only ever be a host card anyway, but the rule is stated as a real game rule, not just an implementation detail).
- `state.cardsPlayedThisTurn` — the 1-normal-card-per-turn cap; only 速攻 (or enc-granted speed, checked generically via `encGrantsSpeed()`) bypasses it.
- `player.safeguard` — one-shot flag consumed on loss-avoidance trigger. (There is deliberately no equivalent persistent flag for reflection — it's a reactive `cha` card now, decided *after* being targeted, not something pre-armed on your own turn.)

### Screens

`showScreen(id)` toggles `.screen` elements' `hidden` attribute and — as a side effect — always force-hides `#play-modal`, since that modal is a non-`.screen` overlay that must never survive a screen switch (e.g. into a cha-response screen) or it'll block input. Screens: `setup-screen`, `transition-screen` (turn handoff, also reused to resume the acting player after a cha phase), `cha-transition-screen` / `cha-response-screen` (cha interrupt handoff — reusable for any stack depth, not just the first interrupt), `game-screen`, `result-screen`, plus the `rules-modal` and `play-modal` overlays. All DOM ids referenced in `game.js` must exist in `index.html`.

When adding a new card effect, add an entry to `CARD_TYPES` with a unique `id` and an `effect` (or, for cha cards, `chaResolve`) function; avoid adding new global state fields unless the effect genuinely needs to persist across turns. Reuse the existing `category`/`sub`/`needsTarget`/`choices`/`peek`/`magnitude`/`encModify`/`chaCanRespond`/`chaResolve` mechanisms before inventing new ones — most new attack/enc/cha cards should fit the existing pipeline without touching `resolvePlayFlow`/`beginChaPhase`/`resolveChaStack`.

### Card illustrations

Card thumbnails are convention-based, not declared per-card: `buildCardVisual(cardId)` tries `assets/cards/<id>.png`, then falls back to `assets/cards/<id>.svg` on a 404 (via the `<img>` `error` handler advancing through a small candidate list), then removes the element entirely if neither exists — falling back to the card's plain color background (today's look). There is no field on `CARD_TYPES` for this and none is needed — dropping a correctly-named file into `assets/cards/` is enough to make it appear everywhere that card is rendered (hand, cha-response, enc/peek picker, rules modal), since they all route through the shared `buildCardBody()` helper. Every card currently has a hand-drawn placeholder SVG (simple white line-art icon); since PNG is tried first, dropping in a real illustration as `<id>.png` overrides the SVG with zero code changes — this is the intended path for swapping in externally-generated art later. See `assets/cards/README.md` for the naming list and size guidance (also used as a prompt sheet for generating the art externally).

### Animation

Animations are plain CSS (`style.css`), triggered by class toggles in `game.js`, with no animation library or FLIP-style diffing — consistent with the rest of the project having no dependencies. Three mechanisms:

- **Screen transitions**: `.screen:not([hidden])` always plays `screenEnter` — since toggling the `hidden` attribute flips `display: none` → `block`, the browser restarts the animation on every `showScreen()` call for free, no JS hook needed.
- **Card entrance**: `.card-btn` always plays `cardEnter`; every call site that builds a list of card buttons (hand, cha-response, enc picker, peek picker, rules modal) sets `btn.style.animationDelay` from its loop index to stagger them. Because `render()` rebuilds these lists from scratch every time, the animation replays automatically on every re-render — this is a feature, not a workaround.
- **Card play feedback**: clicking a directly-playable card button (or a peek/cha-response card) never calls its handler synchronously — it goes through `triggerCardPlayAnimation(btn, onDone)`, which disables the button, adds `.card-playing` (plays `cardPlayPop`), and calls `onDone` after the animation's fixed 200ms via `setTimeout`. This is the one place where a card's *actual* effect is deliberately delayed past the click; keep that delay in sync with `cardPlayPop`'s duration in `style.css` if you change either.

`#current-count` also gets a one-off `count-pulse` class (via the `pulseElement()` reflow-retrigger helper) whenever `render()` sees `state.count` differ from the last render, tracked in the module-level `lastRenderedCount` (reset to `null` on `startGame()` so a fresh game doesn't pulse on its first paint).

All of the above respect `prefers-reduced-motion: reduce` (animations are disabled outright, not shortened) — keep new animations inside that media query too.
