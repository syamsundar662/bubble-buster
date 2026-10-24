# bubble-buster
A simple bubble-popping browser game

Bubbles float up from the bottom. Tap or click them to pop them before the 60 second clock runs out.
Big, slow bubbles are worth 10 points; small, fast ones up to 80. Your best score is kept in the browser.

Keys: `Esc` or `P` pauses, `Enter` starts a new round.

## Files

Plain HTML, CSS and JavaScript, no build step.

- `index.html` – screens and HUD
- `styles.css` – layout and type (Fredoka, self-hosted in `fonts/`, SIL Open Font License)
- `game.js` – canvas rendering, spawning, scoring, synthesised sound
- `_headers` – security headers and font caching for Cloudflare

## Run locally

```sh
npx wrangler dev
```

## Deploy

Served as a Cloudflare Worker with static assets (`wrangler.jsonc`, assets from the repo root;
`.assetsignore` keeps repo files out of the upload):

```sh
npx wrangler deploy
```
