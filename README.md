# Skyjo Online

A free, phone-first multiplayer card game based on Skyjo's mechanics. Open a link, pick a name, and play with 2–8 friends in real time. No accounts. Available in English, Spanish (Latin America), and Portuguese (Brazil).

> Work in progress. See [`docs/PLAN.md`](docs/PLAN.md) for the roadmap. Deploy and self-host sections land with their milestones.

## Play

- **Online with friends:** tap **Create a room**, then **Invite friends** to share the link (or read out the 5-letter code). Everyone enters a name and joins. The host taps **Start game**. If you reload or lose signal, you get your seat back automatically. A ninth person, or anyone arriving mid-game, watches until the game ends.
- **On one phone:** pick 2–8 players and pass the phone around.

## How to play

- Everyone gets 12 face-down cards in a 3 × 4 grid and flips any 2. Whoever's 2 cards add up highest starts.
- On your turn, draw from the deck or take the top card of the discard pile.
  - A deck card can replace any card in your grid, or you can throw it away and flip one of your face-down cards instead.
  - A card from the discard pile must replace a grid card.
  - Whatever you replace goes face up onto the discard pile.
- Three equal face-up cards in a column disappear.
- Reveal your whole grid to end the round. Everyone else gets one last turn, then all cards are revealed and counted. If you ended the round without the strictly lowest score, your positive score is doubled.
- When someone reaches 100 points the game ends. Lowest total wins.

The exact rules, including how edge cases are decided, are in [`AGENTS.md` § Rules](AGENTS.md#rules).

## Run locally

Requires Node 22+.

```sh
npm install
npm run dev        # http://localhost:5173 — app + Worker + Durable Objects, all local
npm test           # unit tests
npm run e2e        # Playwright (first time: npx playwright install chromium webkit)
SERVER=node npx playwright test e2e/online.spec.ts --project=pixel   # same suite on the Node server
```

## Deploy (Cloudflare, free plan)

The app, the Worker and one Durable Object per room deploy together to Cloudflare Workers. The free plan needs no credit card. CI deploys every push to `main` after all checks pass, then plays a 2-phone game against the live URL.

One-time setup:
1. Create a free Cloudflare account. In **Workers & Pages**, pick a `workers.dev` subdomain. Don't create an application; the first deploy does that.
2. Create an API token from the **Edit Cloudflare Workers** template.
3. In the GitHub repo settings, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The game is then live at `https://skyjo-online.<your-subdomain>.workers.dev`. To redeploy by hand, run the CI workflow on `main` from the Actions tab. From your own machine, run `npx wrangler login`, then `npm run build && npx wrangler deploy`.

## Self-host (fallback)

The same rooms also run on plain Node with `ws`, held in memory, so a restart ends every game in progress:

```sh
npm run build && npm run build:node
npm start                      # http://localhost:8787 (PORT=… to change)
```

To let friends reach it without opening router ports, run a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) and share the `https://….trycloudflare.com` URL it prints:

```sh
cloudflared tunnel --url http://localhost:8787
```

This exposes your computer to the internet for as long as the tunnel runs, so stop it (Ctrl-C) when the game ends.

## Contributing

Read [`AGENTS.md`](AGENTS.md) for architecture, commands, conventions, and the PR workflow.

## License

[MIT](LICENSE). Card art and text are original to this project.
