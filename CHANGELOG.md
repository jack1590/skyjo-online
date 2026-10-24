# Changelog

What changed for players, release by release. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/): a major release removes or breaks something players relied on, a minor one adds features, a patch fixes things.

Every merge to `main` deploys to https://skyjo-online.jcarl-30.workers.dev. When the version in `package.json` is new, CI also tags it and publishes a GitHub Release with that version's section from this file, after the live smoke test passes.

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
