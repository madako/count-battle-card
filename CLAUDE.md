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

Key pieces in `game.js`:

- **`CARD_TYPES`** — array of card definitions, each with `id`, `name`, `desc`, `color`, and an `effect(state, playerIndex)` function that mutates `state` and returns a log message. This is the extension point for adding/tuning cards; `CARD_MAP` is the id-keyed lookup built from it. The rules modal (`renderRulesModal`) and hand rendering both iterate this array, so a new entry needs no other wiring beyond `effect`.
- **`state`** — the entire game state (count, limit, players, deck, direction, turn index, per-turn caps/bonuses, log). Created by `createGame(config)` from the setup form values.
- **Turn flow**: `startTurn(playerIndex)` resets per-turn bonuses/caps → player plays 0+ cards via `playCard(cardIndex)` (each calls `render()` immediately) → player calls `advanceCount(amount)` which updates the count, checks the loss condition (respecting a one-time `safeguard`), and either ends the game (`finishGame`) or calls `endTurnAndAdvance()` → `endTurnAndAdvance` computes the next player index (honoring `direction` and `skipNext`) and shows the hot-seat blind transition screen before the next player reveals their hand.
- **Screens**: `showScreen(id)` toggles `.screen` elements' `hidden` attribute; screens are `setup-screen`, `transition-screen` (hides hand from other players between turns), `game-screen`, `result-screen`, plus a `rules-modal` overlay. All DOM ids referenced in `game.js` must exist in `index.html`.
- **Card interactions that affect the *next* turn's cap** (`forced_number`) go through `state.pendingForcedCap`, consumed in `startTurn`; bonuses affecting the *current* turn (`count_boost`) go through `state.turnAdvanceBonus`. `effectiveMaxAdvance()` combines these to compute the max count-advance buttons shown.

When adding a new card effect, add an entry to `CARD_TYPES` with a unique `id` and an `effect` function; avoid adding new global state fields unless the effect genuinely needs to persist across turns.
