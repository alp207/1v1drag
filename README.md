# Dragon Duel Arena

This project now includes:

- a static front end that uses `dragon.png` as the in-game dragon image
- a small Node WebSocket backend for live 1v1 rooms

## Files

- `index.html`: page shell and UI
- `styles.css`: layout and visual styling
- `game.js`: dragon-only client logic
- `dragon.png`: dragon sprite used in the arena
- `build-static.mjs`: builds the static site and injects the live server URL
- `server/server.js`: WebSocket 1v1 arena server
- `server/package.json`: backend package manifest
- `render.yaml`: Render two-service blueprint

## Gameplay

- Click `Play` to spawn directly as a dragon.
- Move by aiming with the mouse.
- Hold left click or press `Space` to boost.
- Right click or press `W` to bite in a live 1v1.
- Press `Q` to queue for another 1v1.

## Render

This repo is now set up for two Render services:

- `dragon-duel-server`: Node WebSocket backend
- `dragon-duel-arena`: static frontend

The easiest path is `New > Blueprint` and point Render at this repo so it reads `render.yaml`.

If you create them manually:

- Backend:
  - Service Type: `Web Service`
  - Root Directory: `server`
  - Build Command: `npm install`
  - Start Command: `npm start`
- Frontend:
  - Service Type: `Static Site`
  - Build Command: `node build-static.mjs`
  - Publish Directory: `dist`
  - Environment Variables:
    - `SKIP_INSTALL_DEPS=true`
    - `LIVE_SERVER_URL=https://your-backend-service.onrender.com`

The frontend build converts `LIVE_SERVER_URL` into the WebSocket address automatically.
