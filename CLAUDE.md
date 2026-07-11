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
- `encModify(context)` — enc-only; mutates the play `context` of whatever card it's attached to (`up_grade` sets `context.encMultiply`, `speed_up` sets `context.forceSpeed`).
- `effect(state, playerIndex, context)` — mutates `state` and returns a log message. Always invoked through `runCardEffect(card, playerIndex, context)`, never called directly, so `magnitude` is computed consistently everywhere (normal play, cha-copy, and `copy_card`'s replay). Effects that read `context.targetIndex`/`context.choice`/`context.peeked` should default sensibly when they're missing, since `copy_card` calls `effect` with a bare `{}`.

Cards tagged `enc` or `cha` are **not directly clickable** in the hand (`isDirectlyPlayable()` gates this) — they only surface inside the play flow (enc) or the cha-response screen (cha). Clicking one directly in the hand just logs an explanatory message.

### Turn flow and the card-play pipeline

`startTurn(playerIndex)` resets per-turn bonuses/caps/`cardsPlayedThisTurn`. Playing a directly-playable card from the hand goes through a multi-step pipeline rather than resolving immediately:

1. `beginCardPlay(handIndex)` opens `state.pendingPlay` and calls `advancePlayFlow()`, which walks through whichever steps the card needs — `enc` (attach an eligible enc card from hand, optional) → `target` (if `needsTarget`) → `choice` (if `choices`) → `peek` (if `peek`) — rendering `#play-modal` (via `renderPlayModal()`) at each step and waiting for a `choose*ForPlay()` call to advance. This all happens on the acting player's own screen, no hidden info involved, so no blind transition is needed here. `cancelPlayFlow()` aborts and returns any peeked cards to the deck.
2. `resolvePlayFlow()` checks the per-turn cap (`state.cardsPlayedThisTurn`) — normal cards are rejected (and stay in hand) if a non-speedy card was already played this turn; cards with `sub: ["速攻"]` or an attached `speed_up` bypass this. On success, the host card (and any attached enc card) move from hand to `state.graveyard`, then `beginChaPhase()` starts.
3. `beginChaPhase(hostPlayerIndex, card, context)` queues every *other* player in turn order and calls `advanceChaPhase()`, which silently skips anyone with no `cha`-tagged card in hand, or shows `cha-transition-screen` → (reveal) → `cha-response-screen` for anyone who has one, letting them play one `cha` card (`playChaResponse`) or pass. This is the one place hidden hands get shown mid-turn, so it reuses the blind-transition pattern.
4. `finishChaPhase()` resolves the host card's effect via `runCardEffect` (skipped if a `cha_deny`-style response set `phase.nullified`), replays it for anyone who responded with a `cha_copy`-style card, sets `state.lastPlayedCard`, and — only if a cha screen was actually shown — blind-transitions back to the acting player before returning to `game-screen`.

After all that, the player can still act again (more 速攻 cards, or `advanceCount(amount)`), same as before: `advanceCount` checks the loss condition and calls `endTurnAndAdvance()`, which computes the next player (honoring `direction`/`skipNext`) and shows the normal `transition-screen`.

### State fields worth knowing

- `pendingForcedCap` (set by `forced_number`, consumed in `startTurn`) vs `turnAdvanceBonus` (current-turn-only bonus, e.g. `count_boost`/`dash`) vs `player.advanceMultiplier` (persists across turns for that player only, e.g. `new_game`'s self-only doubling) — `effectiveMaxAdvance()` combines all three.
- `state.graveyard` — every card that's ever played (host, enc, or cha) lands here; `grave_robber`/`copy_card`-style cards read from it or from `state.lastPlayedCard`.
- `state.cardsPlayedThisTurn` — the 1-normal-card-per-turn cap; only 速攻 (or enc-granted speed) bypasses it.
- `player.reflect` / `player.safeguard` — one-shot flags consumed on trigger (attack-card redirect and loss-avoidance respectively).

### Screens

`showScreen(id)` toggles `.screen` elements' `hidden` attribute and — as a side effect — always force-hides `#play-modal`, since that modal is a non-`.screen` overlay that must never survive a screen switch (e.g. into a cha-response screen) or it'll block input. Screens: `setup-screen`, `transition-screen` (turn handoff, also reused to resume the acting player after a cha phase), `cha-transition-screen` / `cha-response-screen` (cha interrupt handoff), `game-screen`, `result-screen`, plus the `rules-modal` and `play-modal` overlays. All DOM ids referenced in `game.js` must exist in `index.html`.

When adding a new card effect, add an entry to `CARD_TYPES` with a unique `id` and an `effect` function; avoid adding new global state fields unless the effect genuinely needs to persist across turns. Reuse the existing `category`/`sub`/`needsTarget`/`choices`/`peek`/`magnitude` mechanisms before inventing new ones-most new attack/enc/cha cards should fit the existing pipeline without touching `resolvePlayFlow`/`beginChaPhase`/`finishChaPhase`.
