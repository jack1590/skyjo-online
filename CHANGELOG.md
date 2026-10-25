# Changelog

What changed for players, release by release. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/): a major release removes or breaks something players relied on, a minor one adds features, a patch fixes things.

Every merge to `main` deploys to https://skyjo-online.jcarl-30.workers.dev. When the version in `package.json` is new, CI also tags it and publishes a GitHub Release with that version's section from this file, after the live smoke test passes.

## [2.1.3] - 2026-10-25

### Fixed

- After you throw away a card you drew, it's now clear which card to tap. Your face-down cards get a glowing gold outline, and your face-up cards fade back. Before, the only gold outline was on the discard pile, and tapping it only took you back. With reduced motion on, the outline holds still.
- The prompt says what to do: "Now flip one of your face-down cards, or keep the drawn card" (in Spanish, "Ahora voltea una de tus cartas boca abajo…"; in Portuguese, "Agora vire uma das suas cartas viradas para baixo…"). It fits in two lines on small phones.

### Changed

- The card you drew no longer has a gold outline, since tapping it there does nothing. It sits a little higher, with a shadow, as if held in your hand. Gold now marks only the cards you can tap.

## [2.1.1] - 2026-10-25

### Fixed

- When everyone is on Auto-play, the game keeps playing to the round summary, which then waits for a tap on **Next round**. Before, the table froze, with every phone saying "Auto-play is playing for you": when the last player still playing by hand switched Auto-play on, or when two players both ran out of time in the opening flip. So that such a round can end, Auto-play now turns over a player's last face-down card when nobody at the table is playing by hand; while someone is, it still never does that early.

### Changed

- Your turn clock now runs even when everyone else still connected is on Auto-play. Before, it stopped, and the table waited for you for as long as you liked.

### Security

- A table where everyone is on Auto-play now plays with no message from anyone, as long as a seated player is connected. As in 2.1.0, each step is paid by every network with a phone in the room: a 2-player table with both on Auto-play costs each connected network at most 76 of its 120-a-minute budget, and it stops at every round summary. With nobody connected, nothing plays. No new message or route.

## [2.1.0] - 2026-10-24

### Added

- **A turn clock.** Each turn has 30 seconds, and after you draw you always get at least 10 to place the card. A thin bar above your cards drains through your turn, with no number. In the last 10 seconds it turns orange and the pill reads "Your turn · 10", counting down; at 5 seconds it turns red, and your phone vibrates once and plays a soft tick. With sound off you still get the vibration, just not the tick. Everyone else sees that player's gold border drain like a ring, with the seconds in its last 10. The opening flip has the same 30 seconds from the deal, shared by everyone still flipping. The round summary, game over and the lobby have no clock.
- **Auto-play.** When your time runs out, the game makes that move for you and switches on Auto-play ("Juego automático", "Jogada automática"), which keeps playing your turns until you switch it off. It plays one step at a time, so everyone sees the card it draws (after 2 seconds), then where it goes (1.2 seconds later). The switch is in the row above your cards; switch it on yourself before you step away. While it's on, that row says "Auto-play is on", or "Auto-play was on while you were away" when you come back, and tapping your cards, the deck or the discard shakes it instead of playing. Switching it off during your turn gives you a fresh 30 seconds, once per move: switching it on and off again doesn't keep adding time. Everyone else sees 🤖 by your name, "Ana · auto" while it's your turn, and 🤖 in the round summary. People watching see the clocks and the 🤖 too.
- Auto-play plays sensibly. It draws from the deck and swaps the card into your highest face-up card if it's lower. Otherwise it throws the card away and turns over your first face-down card. It never turns over your last face-down card while it can swap instead, since that would end the round and likely double your score; on a last turn, when the round is ending anyway, it does.
- The screen stays on during a game, so at a big table your phone doesn't lock between turns and get played for. It lets go when you leave the table.
- "How to play" explains the clock.

### Changed

- A phone that drops gets the same 30 seconds as everyone else, then Auto-play, and the table shows it in the prompt line: "Cris is offline · auto-play in 24 s". This replaces the 60-second wait on every turn of an offline player, which at 8 players added about 10 minutes a round. It also replaces 2.0.4's rule that moved for a phone that dropped mid-turn 60 seconds after its turn began.
- A host on Auto-play counts as away, so anyone seated can start, deal the next round or play again. A new game starts with everyone's Auto-play off.
- A table only plays itself while someone is really there. A clock runs, and Auto-play plays, only while another seated player is connected and not on Auto-play. A table where everyone is on Auto-play waits for someone to come back, and costs nothing meanwhile.
- The "Your turn" pill pops once per turn, not twice.
- Your cards no longer shrink mid-turn. The offline note now sits in the prompt line instead of a line of its own. The drawn card's "tap to keep" label stays on one line, with shorter Spanish and Portuguese wording, and the Portuguese discard prompt is shorter. To make room for the Auto-play switch, cards on a 390 × 664 screen are 58 px wide instead of 61; on smaller screens they still never go below 44 px.
- With reduced motion, the clock's bar and ring stay still; their colours and seconds still change.
- A phone coming back from the background tells the room at once, so it shows online and a clock that stopped while it was gone starts afresh.
- A tap that lands just after the game moved for you no longer shows "That move isn't allowed."

### Security

- Auto-play moves are made by the server with no message from anyone, so they're paid for like the presence checks in 2.0.4. Each step is an alarm run that costs 2 of the 120-a-minute budget of every network with a phone in the room. One auto turn is 2 steps: 4 storage writes (2 saves, 2 alarms) and 2 Durable Object requests, and it costs each such network 4. A table where everyone is on Auto-play writes nothing.
- The new `auto` message only changes the sender's own seat, writes nothing when it changes nothing, and counts against the same budget as any message.
- Nothing changes for a normal table: 8 friends on one home Wi-Fi still stay under every limit. The busiest case is one player who plays a turn a second while the other 7 are on Auto-play, all on one network, with each of the 7 phones coming back once: 86 of the 120 in the busiest minute (90 even at two taps a second), so nobody is disconnected. Auto-play takes 2 seconds to draw and 1.2 more to place, which keeps each auto turn about as cheap as a human one. One network at every limit still needs at least 14 hours to use up the day's writes.

## [2.0.5] - 2026-10-24

### Changed

- A room now holds up to 20 connected phones or tabs, players included: 8 players and a dozen people watching. Players always get back in, even into a room that is at 20. In a room at 20, a connection the server hasn't heard from for 90 seconds (a phone that dropped without closing) makes room first; if that phone was only asleep, it reconnects when it wakes. Then a phone that reconnects, player or spectator, takes the place of the connection it left behind, and a player who was away takes the place of the spectator the server heard from least recently.
- Anyone else who opens a room at 20 sees "Room ABCDE is full: too many people are connected. Try again later." and a Home button, in English, Spanish or Portuguese. The app doesn't keep retrying behind "Reconnecting…"; reload to try again. A tab opened before this update doesn't know that message: in a room at 20 it keeps retrying, about twice a second, until it is reloaded, and other phones on the same network may then see their reconnects refused for the rest of each minute.

### Security

- No more unlimited connections to one room (SEC-2). Before, a script could hold any number of sockets open in a room (60 measured), and every change in the room went to each of them. Now a room takes 20 sockets that said hello, the game's first message, and a socket keeps the identity of its first hello: saying hello again as someone else is refused, so it can't slip past the limit. The 21st, unless it belongs to a player, is told the room is full and closed. A room only goes past 20 when a player with no connection left comes back to a room full of players' connections, and then by one connection per such player. A turned-away attempt costs what it did to open: 1 Worker request, about 1.1 Durable Object requests (its connection, its hello and its close) and no storage write. Unlike before, it then gets nothing. A change in a crowded room reaches 20 sockets, not 60.
- Sockets that never say hello are closed (SEC-6). The app says hello the moment it connects. A socket that hasn't after 10 seconds gets no updates and doesn't count toward the 20. The server drops it at the next thing that happens in the room: a new connection, a message, a phone leaving or a presence check. No timer or alarm was added for it, so it costs no write and no request. In a room where nothing happens it stays open, idle, until then. Measured on a local Cloudflare runtime, a socket that never sent anything at all is only told it's closed 10 to 30 seconds after it is dropped; one that sent anything, even a keep-alive, is told at once.
- Nobody can push a room past 20 with extra tabs: in a full room, a new tab replaces the same browser's oldest one, which then says the room is full.
- Nothing changes for a normal table. 8 friends on one home Wi-Fi stay within every limit as before, and a phone on a slow connection whose hello takes over 10 seconds just reconnects.
- Self-hosting: the Node server applies the same cap of 20, and closes silent sockets whenever a new one connects.

## [2.0.4] - 2026-10-24

### Security

- Holding rooms open no longer uses up the free plan's daily quotas in under 2 hours. A lobby whose phones stay connected checks every 45 seconds who is still there, and each check costs a storage write and a Durable Object request. Before, one network could open 10 rooms a minute, leave 2 idle phones in each, and use up the day's 100,000 writes in under 2 hours, within every limit.
- The 120-a-minute budget each network has now pays for every storage write it causes, not just its messages:
  - each check is paid by every network with a phone in that room;
  - a phone that connects only to bring a check forward pays for it, even if it leaves before the check;
  - a phone leaving no longer writes anything;
  - creating a room costs 3.

  A network over its budget has its phones in that room disconnected, and they get back in once the minute is up. One network may also make only 30 requests to the API a minute, down from 60.
- If your phone drops during your turn, the server may now play for you 60 seconds after your turn began, rather than 60 seconds after you dropped. The turn timer in 2.1.0 replaces this with a 30-second clock for everyone.
- One network at every limit now needs at least 14 hours to use up the day's writes and 18 hours for the Durable Object requests, whether it holds rooms open, floods messages, or keeps connecting and leaving. Before, that took 1.8 to 10 hours. Several networks together still need proportionally less time.
- Nothing changes for a normal table. 8 friends on one home Wi-Fi, tapping once a second, use at most 87 of their 120 in any minute, presence checks included; at a tap every 2 seconds, at most 57. Long waits in the lobby or over the round summary, and slow turns, use even less, and the dots that show who is online still update on time. 8 phones on very bad Wi-Fi (every connection dropping every 15–45 seconds) make about 22 API requests in their busiest minute.
- **Still open:** our own "too many requests" answers still count toward the Workers free plan's 100,000 requests a day, so a flood of plain requests can stop new connections until 00:00 UTC (the site itself keeps loading). Only a WAF rule on a custom domain or Workers Paid avoids that, a choice deferred to launch. Forgotten lobbies with tabs left open keep costing writes until they expire (SEC-9).

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
