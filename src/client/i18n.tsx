import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

const en = {
  tagline: "Flip, swap, and keep your score low.",
  language: "Language",
  playersCount: "{n} players",
  startGame: "Start game",
  howToPlay: "How to play",
  rules1:
    "Everyone gets 12 face-down cards in a 3 × 4 grid and flips any 2. Whoever's 2 cards add up highest starts.",
  rules2: "On your turn, draw from the deck or take the top card of the discard pile.",
  rules3:
    "A deck card can replace any card in your grid, or you can throw it away and flip one of your face-down cards instead. A card from the discard pile must replace a grid card.",
  rules4: "Three equal face-up cards in a column disappear.",
  rules5:
    "Reveal your whole grid to end the round; everyone else gets one last turn. If you don't have the strictly lowest score, your positive score is doubled.",
  rules6: "When someone reaches 100 points the game ends. Lowest total wins.",
  rules7:
    "Each turn has 30 seconds, and at least 10 to place a card you drew. When time runs out, Auto-play plays for you until you switch it off. You can switch it on yourself before stepping away.",
  round: "Round {n}",
  flipTwo: "Flip 2 cards",
  lastTurnPill: "Last turn · {name}",
  quit: "Quit to home",
  confirmLeave: "Leave this game?",
  showScores: "Show scores",
  deck: "Deck",
  deckCount: "Deck · {n}",
  drawn: "Drawn",
  drawnCard: "Drawn card",
  undo: "Undo",
  discard: "Discard",
  fromDiscard: "From the discard",
  discardPile: "Discard pile",
  pts: "{n} pts",
  where: "row {row}, column {col}",
  waitingFlip: "Waiting for others to flip…",
  lastTurn: "Last turn! ",
  waiting: "Waiting for {name}…",
  swapIn: "From the discard: tap a grid card to swap it in",
  discardMode: "Now flip one of your face-down cards",
  place: "Tap a grid card to swap, or the discard pile to throw it away",
  winsOne: "{names} wins!",
  winsMany: "{names} win!",
  roundOver: "Round {n} over",
  viewTable: "View table",
  colPlayer: "Player",
  colRound: "Round",
  colTotal: "Total",
  ended: "ended",
  home: "Home",
  playAgain: "Play again",
  nextRound: "Next round",
  crashed: "Something went wrong. Reload to get back to your game.",
  reload: "Reload",
  faceDown: "{label}: face down",
  empty: "{label}: empty",
  yourTurn: "Your turn",
  yourLastTurn: "Your last turn",
  offline: "offline",
  watching: "You're watching this game",
  waitingHost: "Waiting for the host…",
  playOnline: "Play online with friends",
  createRoom: "Create a room",
  createFailed: "Couldn't create a room. Check your connection and try again.",
  tooManyRequests: "Too many requests from your network. Wait a minute and try again.",
  roomCode: "Room code",
  join: "Join",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  roomNotFound: "There's no room {code}.",
  roomCrowded: "Room {code} is full: too many people are connected. Try again later.",
  shareLink: "Invite friends",
  copied: "Link copied",
  invite: "Join my Skyjo Online game!",
  host: "host",
  you: "you",
  yourName: "Your name",
  leaveSeat: "Leave seat",
  needTwo: "At least 2 players are needed to start.",
  roomFull: "The room is full (8 players). You can watch.",
  errBadMessage: "Something went wrong. Try again.",
  errNotAllowed: "That's not allowed right now.",
  errRoomFull: "The room is full.",
  errBadName: "Enter a name.",
  errNameTaken: "That name is taken.",
  errIllegalMove: "That move isn't allowed.",
  removePlayer: "Remove {name}",
  installHint: "Install it: tap Share, then “Add to Home Screen”.",
  gotIt: "Got it",
  offlineHome: "You're offline. Skyjo Online needs a connection to play.",
  sound: "Sound",
  showCards: "Show {name}'s cards",
  close: "Close",
  whatsNew: "What's new",
  offlineNote: "{name} is offline",
  autoPlayIn: "auto-play in {s} s",
  autoPlay: "Auto-play",
  // Throws (M21): the item names and what each says when it lands.
  throwAt: "Throw at {name}",
  throws: "Throws",
  tossedYou: "{name} threw you: {item}",
  item_bomb: "Bomb",
  item_beer: "Beer",
  item_donkey: "Donkey",
  item_tomato: "Tomato",
  item_slipper: "Flip-flop",
  item_kiss: "Kiss",
  gag_bomb: "Boom!",
  gag_beer: "Cheers!",
  gag_donkey: "Hee-haw!",
  gag_tomato: "Splat!",
  gag_slipper: "Bonk!",
  gag_kiss: "Mwah!",
  autoOn: "Auto-play is on",
  autoAway: "Auto-play was on while you were away",
  autoPill: "{name} · auto",
  autoPrompt: "Auto-play is playing for you. Switch it off to play.",
  secondsLeft: "{s} seconds left",
  offlineRoom: "You're offline. Reconnect to join this room.",
  playersOne: "1 player",
  flipOnePlain: "Flip 1 card",
  flipManyPlain: "Flip {n} cards",
  drawPlain: "Draw from the deck or take the discard",
  rules8:
    "Play until one is left (the host's choice in the lobby): after each round, everyone at 100 or more is out and watches. The last player under 100 wins; if everyone left reaches 100 in the same round, the lowest total wins.",
  knockout: "Play until one is left",
  knockoutHelp: "After each round, everyone at 100 or more is out. The last one under 100 wins.",
  outWatching: "Out · watching",
  outInRound: "Out in round {n}",
  youWin: "You win!",
  youShare: "You share the win!",
  youPlaced: "You placed {n}",
  youreOut: "You're out · watching",
  hostNewGame: "The host can start a new game",
  starts: "{name} starts: highest pair ({n})",
  youStart: "You start: highest pair ({n}).",
  tied: "tied",
  lastCard: "Revealing your last card ends the round",
  everyoneFlips: "Everyone flips 2",
  thisRound: "this round",
};

export type Key = keyof typeof en;

/** Latin American Spanish. */
const es: Record<Key, string> = {
  tagline: "Voltea, cambia y mantén tu puntaje bajo.",
  language: "Idioma",
  playersCount: "{n} jugadores",
  startGame: "Empezar partida",
  howToPlay: "Cómo jugar",
  rules1:
    "Cada jugador recibe 12 cartas boca abajo en una cuadrícula de 3 × 4 y voltea las 2 que elija. Empieza quien sume más con esas 2.",
  rules2: "En tu turno, roba del mazo o toma la carta de arriba del descarte.",
  rules3:
    "Una carta del mazo puede reemplazar cualquier carta de tu cuadrícula, o puedes descartarla y voltear una de tus cartas boca abajo. Una carta del descarte debe reemplazar una carta de tu cuadrícula.",
  rules4: "Tres cartas iguales boca arriba en una columna desaparecen.",
  rules5:
    "Revela toda tu cuadrícula para terminar la ronda; los demás juegan un último turno. Si no tienes el puntaje estrictamente más bajo, tu puntaje positivo se duplica.",
  rules6: "Cuando alguien llega a 100 puntos, termina la partida. Gana el total más bajo.",
  rules7:
    "Cada turno tiene 30 segundos, y al menos 10 para colocar la carta que robaste. Si se acaba el tiempo, el juego automático juega por ti hasta que lo desactives. También puedes activarlo antes de alejarte.",
  round: "Ronda {n}",
  flipTwo: "Voltea 2 cartas",
  lastTurnPill: "Último turno · {name}",
  quit: "Salir al inicio",
  confirmLeave: "¿Salir de esta partida?",
  showScores: "Ver puntajes",
  deck: "Mazo",
  deckCount: "Mazo · {n}",
  drawn: "Robada",
  drawnCard: "Carta robada",
  undo: "Deshacer",
  discard: "Descarte",
  fromDiscard: "Del descarte",
  discardPile: "Pila de descarte",
  pts: "{n} pts",
  where: "fila {row}, columna {col}",
  waitingFlip: "Esperando a que los demás volteen…",
  lastTurn: "¡Último turno! ",
  waiting: "Esperando a {name}…",
  swapIn: "Del descarte: toca una carta de tu cuadrícula para cambiarla",
  discardMode: "Ahora voltea una de tus cartas boca abajo",
  place: "Toca una carta para cambiarla, o el descarte para tirar la robada",
  winsOne: "¡Gana {names}!",
  winsMany: "¡Ganan {names}!",
  roundOver: "Fin de la ronda {n}",
  viewTable: "Ver mesa",
  colPlayer: "Jugador",
  colRound: "Ronda",
  colTotal: "Total",
  ended: "cerró",
  home: "Inicio",
  playAgain: "Jugar otra vez",
  nextRound: "Siguiente ronda",
  crashed: "Algo salió mal. Recarga para volver a tu partida.",
  reload: "Recargar",
  faceDown: "{label}: boca abajo",
  empty: "{label}: vacía",
  yourTurn: "Tu turno",
  yourLastTurn: "Tu último turno",
  offline: "desconectado",
  watching: "Estás mirando esta partida",
  waitingHost: "Esperando al anfitrión…",
  playOnline: "Jugar en línea con amigos",
  createRoom: "Crear una sala",
  createFailed: "No se pudo crear la sala. Revisa tu conexión e inténtalo de nuevo.",
  tooManyRequests: "Demasiadas solicitudes desde tu red. Espera un minuto e inténtalo de nuevo.",
  roomCode: "Código de sala",
  join: "Unirse",
  connecting: "Conectando…",
  reconnecting: "Reconectando…",
  roomNotFound: "No existe la sala {code}.",
  roomCrowded:
    "La sala {code} está llena: hay demasiadas personas conectadas. Inténtalo más tarde.",
  shareLink: "Invitar amigos",
  copied: "Enlace copiado",
  invite: "¡Únete a mi partida de Skyjo Online!",
  host: "anfitrión",
  you: "tú",
  yourName: "Tu nombre",
  leaveSeat: "Dejar el lugar",
  needTwo: "Se necesitan al menos 2 jugadores para empezar.",
  roomFull: "La sala está llena (8 jugadores). Puedes mirar.",
  errBadMessage: "Algo salió mal. Inténtalo de nuevo.",
  errNotAllowed: "Eso no está permitido ahora.",
  errRoomFull: "La sala está llena.",
  errBadName: "Escribe un nombre.",
  errNameTaken: "Ese nombre ya está en uso.",
  errIllegalMove: "Esa jugada no está permitida.",
  removePlayer: "Quitar a {name}",
  installHint: "Instálala: toca Compartir y luego “Agregar a inicio”.",
  gotIt: "Entendido",
  offlineHome: "Estás sin conexión. Skyjo Online necesita conexión para jugar.",
  sound: "Sonido",
  showCards: "Ver las cartas de {name}",
  close: "Cerrar",
  whatsNew: "Novedades",
  offlineNote: "{name} está desconectado",
  autoPlayIn: "juego automático en {s} s",
  autoPlay: "Juego automático",
  throwAt: "Lanzarle a {name}",
  throws: "Lanzamientos",
  tossedYou: "{name} te lanzó: {item}",
  item_bomb: "Bomba",
  item_beer: "Cerveza",
  item_donkey: "Burro",
  item_tomato: "Tomate",
  item_slipper: "Chancla",
  item_kiss: "Beso",
  gag_bomb: "¡Bum!",
  gag_beer: "¡Salud!",
  gag_donkey: "¡Iii-aah!",
  gag_tomato: "¡Plaf!",
  gag_slipper: "¡Chanclazo!",
  gag_kiss: "¡Muak!",
  autoOn: "El juego automático está activado",
  autoAway: "El juego automático jugó mientras no estabas",
  autoPill: "{name} · auto",
  autoPrompt: "El juego automático juega por ti. Desactívalo para jugar.",
  secondsLeft: "Quedan {s} segundos",
  offlineRoom: "Estás sin conexión. Conéctate para entrar a esta sala.",
  playersOne: "1 jugador",
  flipOnePlain: "Voltea 1 carta",
  flipManyPlain: "Voltea {n} cartas",
  drawPlain: "Roba del mazo o toma el descarte",
  rules8:
    "Jugar hasta que quede uno (lo elige el anfitrión en la sala): después de cada ronda, quien tenga 100 o más queda fuera y mira. Gana el último por debajo de 100; si todos los que quedan llegan a 100 en la misma ronda, gana el total más bajo.",
  knockout: "Jugar hasta que quede uno",
  knockoutHelp:
    "Después de cada ronda, quien tenga 100 o más queda fuera. Gana el último por debajo de 100.",
  outWatching: "Fuera · mirando",
  outInRound: "Fuera en la ronda {n}",
  youWin: "¡Ganaste!",
  youShare: "¡Compartes la victoria!",
  youPlaced: "Quedaste en {n} lugar",
  youreOut: "Estás fuera · mirando",
  hostNewGame: "El anfitrión puede empezar otra partida",
  starts: "{name} empieza: el par más alto ({n})",
  youStart: "Empiezas tú: el par más alto ({n}).",
  tied: "empate",
  lastCard: "Revelar tu última carta termina la ronda",
  everyoneFlips: "Todos voltean 2",
  thisRound: "en esta ronda",
};

/** Brazilian Portuguese. */
const pt: Record<Key, string> = {
  tagline: "Vire, troque e mantenha sua pontuação baixa.",
  language: "Idioma",
  playersCount: "{n} jogadores",
  startGame: "Começar partida",
  howToPlay: "Como jogar",
  rules1:
    "Cada jogador recebe 12 cartas viradas para baixo em uma grade de 3 × 4 e vira 2 à sua escolha. Começa quem tiver a maior soma dessas 2.",
  rules2: "Na sua vez, compre do monte ou pegue a carta de cima do descarte.",
  rules3:
    "Uma carta do monte pode substituir qualquer carta da sua grade, ou você pode descartá-la e virar uma das suas cartas viradas para baixo. Uma carta do descarte precisa substituir uma carta da grade.",
  rules4: "Três cartas iguais viradas para cima em uma coluna desaparecem.",
  rules5:
    "Revele toda a sua grade para encerrar a rodada; os outros jogam uma última vez. Se você não tiver a pontuação estritamente mais baixa, sua pontuação positiva dobra.",
  rules6: "Quando alguém chega a 100 pontos, a partida termina. Vence o menor total.",
  rules7:
    "Cada vez tem 30 segundos, e pelo menos 10 para colocar a carta que você comprou. Se o tempo acabar, a jogada automática joga por você até você desativá-la. Você também pode ativá-la antes de sair.",
  round: "Rodada {n}",
  flipTwo: "Vire 2 cartas",
  lastTurnPill: "Última jogada · {name}",
  quit: "Sair para o início",
  confirmLeave: "Sair desta partida?",
  showScores: "Ver pontuação",
  deck: "Monte",
  deckCount: "Monte · {n}",
  drawn: "Comprada",
  drawnCard: "Carta comprada",
  undo: "Desfazer",
  discard: "Descarte",
  fromDiscard: "Do descarte",
  discardPile: "Pilha de descarte",
  pts: "{n} pts",
  where: "linha {row}, coluna {col}",
  waitingFlip: "Esperando os outros virarem…",
  lastTurn: "Última jogada! ",
  waiting: "Esperando {name}…",
  swapIn: "Do descarte: toque numa carta da sua grade para trocar",
  discardMode: "Agora vire uma das suas cartas viradas para baixo",
  place: "Toque em uma carta para trocar, ou no descarte para jogar a comprada fora",
  winsOne: "{names} venceu!",
  winsMany: "{names} venceram!",
  roundOver: "Fim da rodada {n}",
  viewTable: "Ver mesa",
  colPlayer: "Jogador",
  colRound: "Rodada",
  colTotal: "Total",
  ended: "encerrou",
  home: "Início",
  playAgain: "Jogar de novo",
  nextRound: "Próxima rodada",
  crashed: "Algo deu errado. Recarregue para voltar à sua partida.",
  reload: "Recarregar",
  faceDown: "{label}: virada para baixo",
  empty: "{label}: vazia",
  yourTurn: "Sua vez",
  yourLastTurn: "Sua última jogada",
  offline: "desconectado",
  watching: "Você está assistindo a esta partida",
  waitingHost: "Esperando o anfitrião…",
  playOnline: "Jogar online com amigos",
  createRoom: "Criar uma sala",
  createFailed: "Não foi possível criar a sala. Verifique sua conexão e tente de novo.",
  tooManyRequests: "Muitas solicitações da sua rede. Aguarde um minuto e tente novamente.",
  roomCode: "Código da sala",
  join: "Entrar",
  connecting: "Conectando…",
  reconnecting: "Reconectando…",
  roomNotFound: "A sala {code} não existe.",
  roomCrowded: "A sala {code} está cheia: há pessoas demais conectadas. Tente mais tarde.",
  shareLink: "Convidar amigos",
  copied: "Link copiado",
  invite: "Entre na minha partida de Skyjo Online!",
  host: "anfitrião",
  you: "você",
  yourName: "Seu nome",
  leaveSeat: "Sair do lugar",
  needTwo: "São necessários pelo menos 2 jogadores para começar.",
  roomFull: "A sala está cheia (8 jogadores). Você pode assistir.",
  errBadMessage: "Algo deu errado. Tente de novo.",
  errNotAllowed: "Isso não é permitido agora.",
  errRoomFull: "A sala está cheia.",
  errBadName: "Digite um nome.",
  errNameTaken: "Esse nome já está em uso.",
  errIllegalMove: "Essa jogada não é permitida.",
  removePlayer: "Remover {name}",
  installHint: "Instale: toque em Compartilhar e depois em “Adicionar à Tela de Início”.",
  gotIt: "Entendi",
  offlineHome: "Você está offline. O Skyjo Online precisa de conexão para jogar.",
  sound: "Som",
  showCards: "Ver as cartas de {name}",
  close: "Fechar",
  whatsNew: "Novidades",
  offlineNote: "{name} está desconectado",
  autoPlayIn: "jogada automática em {s} s",
  autoPlay: "Jogada automática",
  throwAt: "Jogar em {name}",
  throws: "Arremessos",
  tossedYou: "{name} jogou em você: {item}",
  item_bomb: "Bomba",
  item_beer: "Cerveja",
  item_donkey: "Burro",
  item_tomato: "Tomate",
  item_slipper: "Chinelo",
  item_kiss: "Beijo",
  gag_bomb: "Bum!",
  gag_beer: "Saúde!",
  gag_donkey: "Ióóó!",
  gag_tomato: "Splash!",
  gag_slipper: "Chinelada!",
  gag_kiss: "Smack!",
  autoOn: "A jogada automática está ativada",
  autoAway: "A jogada automática jogou enquanto você estava fora",
  autoPill: "{name} · auto",
  autoPrompt: "A jogada automática joga por você. Desative para jogar.",
  secondsLeft: "Faltam {s} segundos",
  offlineRoom: "Você está offline. Conecte-se para entrar nesta sala.",
  playersOne: "1 jogador",
  flipOnePlain: "Vire 1 carta",
  flipManyPlain: "Vire {n} cartas",
  drawPlain: "Compre do monte ou pegue o descarte",
  rules8:
    "Jogar até sobrar um (o anfitrião escolhe na sala): depois de cada rodada, quem tiver 100 ou mais sai e assiste. Vence o último abaixo de 100; se todos que restam chegarem a 100 na mesma rodada, vence o menor total.",
  knockout: "Jogar até sobrar um",
  knockoutHelp: "Depois de cada rodada, quem tiver 100 ou mais sai. Vence o último abaixo de 100.",
  outWatching: "Fora · assistindo",
  outInRound: "Fora na rodada {n}",
  youWin: "Você venceu!",
  youShare: "Você divide a vitória!",
  youPlaced: "Você ficou em {n} lugar",
  youreOut: "Você está fora · assistindo",
  hostNewGame: "O anfitrião pode começar outra partida",
  starts: "{name} começa: o maior par ({n})",
  youStart: "Você começa: o maior par ({n}).",
  tied: "empate",
  lastCard: "Revelar sua última carta encerra a rodada",
  everyoneFlips: "Todos viram 2",
  thisRound: "nesta rodada",
};

export const LOCALES = {
  en: { name: "English", tag: "en", dict: en },
  es: { name: "Español", tag: "es-419", dict: es },
  pt: { name: "Português", tag: "pt-BR", dict: pt },
} as const;

export type Locale = keyof typeof LOCALES;
export type T = (key: Key, params?: Record<string, string | number>) => string;

const STORAGE_KEY = "skyjo:locale";

/** Saved choice first, then the browser's preferred languages, then English. */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LOCALES) return saved as Locale;
  } catch {
    // Storage blocked: fall through to the browser languages.
  }
  for (const lang of navigator.languages ?? [navigator.language]) {
    const base = lang.slice(0, 2).toLowerCase();
    if (base in LOCALES) return base as Locale;
  }
  return "en";
}

const EN_ORDINAL = new Intl.PluralRules("en", { type: "ordinal" });
const EN_SUFFIX: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "st", two: "nd", few: "rd" };

/** A place in the final ranking (UX-17), before "lugar" in es and pt: 3rd, 3.er, 3º. */
export function ordinal(locale: Locale, n: number): string {
  if (locale === "es") return n === 1 || n === 3 ? `${n}.er` : `${n}.º`; // primer, tercer lugar
  if (locale === "pt") return `${n}º`;
  return `${n}${EN_SUFFIX[EN_ORDINAL.select(n)] ?? "th"}`;
}

export function translator(locale: Locale): T {
  const dict: Record<Key, string> = LOCALES[locale].dict;
  return (key, params) =>
    dict[key].replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
}

interface I18nValue {
  locale: Locale;
  t: T;
  setLocale: (locale: Locale) => void;
}

const I18n = createContext<I18nValue>({
  locale: "en",
  t: translator("en"),
  setLocale: () => {},
});

export const useI18n = () => useContext(I18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(detectLocale);
  useEffect(() => {
    document.documentElement.lang = LOCALES[locale].tag;
  }, [locale]);
  const value = useMemo(
    () => ({
      locale,
      t: translator(locale),
      setLocale: (next: Locale) => {
        setLocaleState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Not remembered across reloads; still applies now.
        }
      },
    }),
    [locale],
  );
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}
