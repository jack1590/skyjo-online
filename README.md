# Skyjo Online

A free, phone-first multiplayer card game based on Skyjo's mechanics. Open a link, pick a name, and play with 2–8 friends in real time. No accounts.

> Work in progress. See [`docs/PLAN.md`](docs/PLAN.md) for the roadmap. Today you can play on one phone, passing it around (hot-seat). Online rooms, deploy, and self-host sections land with their milestones.

## How to play

- Everyone gets 12 face-down cards in a 3 × 4 grid and flips any 2. The highest pair starts.
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
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run e2e        # Playwright (first time: npx playwright install chromium webkit)
```

## Contributing

Read [`AGENTS.md`](AGENTS.md) for architecture, commands, conventions, and the PR workflow.

## License

[MIT](LICENSE). Card art and text are original to this project.
