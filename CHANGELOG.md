# Changelog

What changed for players, release by release. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/): a major release removes or breaks something players relied on, a minor one adds features, a patch fixes things.

Every merge to `main` deploys to https://skyjo-online.jcarl-30.workers.dev. When the version in `package.json` is new, CI also tags it and publishes a GitHub Release with that version's section from this file, after the live smoke test passes.

## [2.0.3] - 2026-10-24

### Security

- Three cheap ways for one script to use up the day's free-plan quotas are now limited. Each network (one IP address, or one IPv6 /64, which is what a home or a phone gets) now has three limits a minute: 60 requests to the API, including opening a connection to a room; 10 new rooms, down from 60; and 120 messages from all its phones, in every room. Before, only room creation was limited, so a loop of joins and leaves from one phone could use up the 100,000 storage writes a day in about 2.3 hours and stop every game until 00:00 UTC. A message loop like that now needs about 14 hours from one network, and floods of API requests or new rooms no longer reach the rooms at all.
- **Not fixed yet:** one network can still use up the day's storage writes and Durable Object requests in about 2 hours, all within these limits, by holding many rooms open with phones that only stay connected (before this release, about 50 minutes). Each such room checks who is still there every 45 seconds, and each check costs a write. The next release (2.0.4, SEC-11) addresses this.
- Nothing changes for a normal table. 8 friends on one home Wi-Fi, tapping once a second, which is faster than anyone plays, send at most 81 messages in any minute, and that minute includes everyone reconnecting at once. At a tap every 2 seconds they send 44.
- If a network does go over: creating a room says "Too many requests from your network. Wait a minute and try again." instead of blaming the connection. A phone over the message limit shows "Reconnecting…", tries again every 20 seconds, and gets back in once the minute is up.
- For operators: a request over the limit gets a 429 from the Worker before any Durable Object is touched, so it costs no Durable Object request and no storage write. **Known limit:** that 429 still counts toward the Workers free plan's 100,000 requests a day, because every `/api` request runs the Worker. A flood from one IP can still use up that quota and stop new connections until 00:00 UTC (the site itself keeps loading). Only a WAF rate-limiting rule on a custom domain, or Workers Paid, avoids that; that choice is deferred to launch (`docs/PLAN.md`, option c). The limits are approximate: Cloudflare counts per data center and lets a few extra through.
- The live smoke test now plays one round on the live site instead of a whole game, since a test bot from one CI machine plays far faster than the message limit allows.
- Self-hosting: the Node server applies the same 120 messages a minute per address, and behind a `cloudflared` tunnel it counts each player's own address. Nothing else changes there.

## [2.0.2] - 2026-10-24

### Security

- Messages that change nothing no longer write to storage. Before, every repeated "hello" from a connected phone cost one row written, so one script could use up the free plan's 100,000 rows a day in about 2.3 hours and stop every game until 00:00 UTC. Now repeated hellos and spectators leaving write nothing and reach no other phone, as rejected moves already did. Nothing changes in play.
- For operators: a real move now writes about 1.1 rows instead of 2.05, so rows written, the free plan's tightest quota, hold roughly twice as many games a day. The room saves its state once per move and sets its alarm only when the next check moves earlier. An alarm that comes early just checks again, which costs one Durable Object request: about 25–60 more per game, out of 100,000 a day.

## [2.0.1] - 2026-10-24

### Fixed

- Sound on iPhone. Sounds now unlock the way iOS expects (on the tap's release, with a silent "warm-up" note), and come back after you switch apps, lock the phone or get a call. Like other games, they still follow the ring/silent switch: if the phone is on silent, so is the game.

## [2.0.0] - 2026-10-24

### Removed

- Local "play on this phone" mode. Skyjo Online is now online rooms only: create a room, share the link, play from each phone.

### Added

- Sound effects for drawing, flipping, placing and discarding cards, dealing, clearing a column, your turn, winning and game over. Recorded card sounds (CC0, by Kenney).
- 🔊 button to mute sounds. It's remembered, and an iPhone on silent stays silent.
- Opponents in a swipeable strip, readable with any number of players. Whoever is playing slides into view, and you can tap an opponent to see their grid full size.
- Spectators see every grid in two columns.
- "What's new" link to these release notes on the home screen.

### Changed

- The header says "Your last turn" when your final turn comes.

## [1.0.1] - 2026-10-24

### Fixed

- Developer docs pointed to the wrong place for the service worker.
- Added a test that the small-phone scroll works with animations on.

## [1.0.0] - 2026-10-24

First complete release: 2–8 phones can play a full game online.

### Added

- Cards fly between deck, discard and grids, flip in 3D, and scores count up. All of it is off when your phone asks for reduced motion.
- Installable app with its own icon. After one visit the app opens offline and says it needs a connection to play.
- "Add to Home Screen" hint on iPhone.
- "Cris is offline · auto-move in 42 s" when the table is waiting on someone who dropped.
- On small phones, your grid scrolls into view when your turn starts.

### Changed

- Doubled round scores read "57 ×2 = 114".

## [0.4.0] - 2026-10-24

### Added

- The game is live on Cloudflare at https://skyjo-online.jcarl-30.workers.dev. Every change deploys after an automated 2-phone game passes on the live site.
- Self-hosting on your own computer (Node), behind a Cloudflare tunnel if you choose.

### Security

- Room creation is rate-limited, and abusive connections are cut off.
- The self-hosted server only listens on your own computer unless you say otherwise.

## [0.3.0] - 2026-10-24

### Added

- Online rooms: create a room, share the link or 5-letter code, and join with just a name.
- The host starts the game, advances rounds and offers a rematch. If the host drops, anyone can.
- Reload or lose signal and you get your seat back.
- A ninth phone, or anyone arriving mid-game, watches as a spectator.
- If a player is gone for 60 s on their turn, the server makes a safe move for them so the table never freezes.

## [0.2.0] - 2026-10-23

### Added

- Play on one phone, passing it around (removed in 2.0.0).
- Original card art and a phone-first table with tap-only controls.
- English, Spanish (Latin America) and Portuguese (Brazil), detected from your phone and switchable.

## [0.1.0] - 2026-10-23

### Added

- Rules engine: 150-card deck, 3×4 grids, column removal, last turns, doubling, game to 100. Every rule is covered by tests.

[2.0.0]: https://github.com/jack1590/skyjo-online/releases/tag/v2.0.0
[1.0.1]: https://github.com/jack1590/skyjo-online/releases/tag/v1.0.1
[1.0.0]: https://github.com/jack1590/skyjo-online/releases/tag/v1.0.0
[0.4.0]: https://github.com/jack1590/skyjo-online/releases/tag/v0.4.0
[0.3.0]: https://github.com/jack1590/skyjo-online/releases/tag/v0.3.0
[0.2.0]: https://github.com/jack1590/skyjo-online/releases/tag/v0.2.0
[0.1.0]: https://github.com/jack1590/skyjo-online/releases/tag/v0.1.0
