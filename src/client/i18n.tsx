import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

const en = {
  tagline: "Flip, swap, and keep your score low.",
  language: "Language",
  playOnPhone: "Play on this phone",
  fewerPlayers: "Fewer players",
  morePlayers: "More players",
  playersCount: "{n} players",
  playerName: "Player {n} name",
  defaultName: "Player {n}",
  startGame: "Start game",
  howToPlay: "How to play",
  rules1:
    "Everyone gets 12 face-down cards in a 3 × 4 grid and flips any 2. The highest pair starts.",
  rules2: "On your turn, draw from the deck or take the top card of the discard pile.",
  rules3:
    "A deck card can replace any card in your grid, or you can throw it away and flip one of your face-down cards instead. A card from the discard pile must replace a grid card.",
  rules4: "Three equal face-up cards in a column disappear.",
  rules5:
    "Reveal your whole grid to end the round; everyone else gets one last turn. If you don't have the strictly lowest score, your positive score is doubled.",
  rules6: "When someone reaches 100 points the game ends. Lowest total wins.",
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
  tapToKeep: "Tap to keep",
  discard: "Discard",
  discardPile: "Discard pile",
  pts: "{n} pts",
  where: "row {row}, column {col}",
  flipOne: "{name}: flip 1 card",
  flipMany: "{name}: flip {n} cards",
  waitingFlip: "Waiting for others to flip…",
  lastTurn: "Last turn! ",
  draw: "{name}: draw from the deck or take the discard",
  waiting: "Waiting for {name}…",
  swapIn: "Tap a card in your grid to swap it in",
  discardMode: "Tap a face-down card to flip it, or the drawn card to keep it",
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
  passTo: "Pass to {name} →",
  crashed: "Something went wrong, so the saved game was cleared.",
  startOver: "Start over",
  faceDown: "{label}: face down",
  empty: "{label}: empty",
};

export type Key = keyof typeof en;

/** Latin American Spanish. */
const es: Record<Key, string> = {
  tagline: "Voltea, cambia y mantén tu puntaje bajo.",
  language: "Idioma",
  playOnPhone: "Jugar en este teléfono",
  fewerPlayers: "Menos jugadores",
  morePlayers: "Más jugadores",
  playersCount: "{n} jugadores",
  playerName: "Nombre del jugador {n}",
  defaultName: "Jugador {n}",
  startGame: "Empezar partida",
  howToPlay: "Cómo jugar",
  rules1:
    "Cada jugador recibe 12 cartas boca abajo en una cuadrícula de 3 × 4 y voltea 2 cualesquiera. Empieza quien tenga el par más alto.",
  rules2: "En tu turno, roba del mazo o toma la carta de arriba del descarte.",
  rules3:
    "Una carta del mazo puede reemplazar cualquier carta de tu cuadrícula, o puedes descartarla y voltear una de tus cartas boca abajo. Una carta del descarte debe reemplazar una carta de tu cuadrícula.",
  rules4: "Tres cartas iguales boca arriba en una columna desaparecen.",
  rules5:
    "Revela toda tu cuadrícula para terminar la ronda; los demás juegan un último turno. Si no tienes el puntaje estrictamente más bajo, tu puntaje positivo se duplica.",
  rules6: "Cuando alguien llega a 100 puntos, termina la partida. Gana el total más bajo.",
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
  tapToKeep: "Toca para quedártela",
  discard: "Descarte",
  discardPile: "Pila de descarte",
  pts: "{n} pts",
  where: "fila {row}, columna {col}",
  flipOne: "{name}: voltea 1 carta",
  flipMany: "{name}: voltea {n} cartas",
  waitingFlip: "Esperando a que los demás volteen…",
  lastTurn: "¡Último turno! ",
  draw: "{name}: roba del mazo o toma el descarte",
  waiting: "Esperando a {name}…",
  swapIn: "Toca una carta de tu cuadrícula para cambiarla",
  discardMode: "Toca una carta boca abajo para voltearla, o la carta robada para quedártela",
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
  passTo: "Pasar a {name} →",
  crashed: "Algo salió mal, así que se borró la partida guardada.",
  startOver: "Empezar de nuevo",
  faceDown: "{label}: boca abajo",
  empty: "{label}: vacía",
};

/** Brazilian Portuguese. */
const pt: Record<Key, string> = {
  tagline: "Vire, troque e mantenha sua pontuação baixa.",
  language: "Idioma",
  playOnPhone: "Jogar neste celular",
  fewerPlayers: "Menos jogadores",
  morePlayers: "Mais jogadores",
  playersCount: "{n} jogadores",
  playerName: "Nome do jogador {n}",
  defaultName: "Jogador {n}",
  startGame: "Começar partida",
  howToPlay: "Como jogar",
  rules1:
    "Cada jogador recebe 12 cartas viradas para baixo em uma grade de 3 × 4 e vira 2 quaisquer. Quem tiver o maior par começa.",
  rules2: "Na sua vez, compre do monte ou pegue a carta de cima do descarte.",
  rules3:
    "Uma carta do monte pode substituir qualquer carta da sua grade, ou você pode descartá-la e virar uma das suas cartas viradas para baixo. Uma carta do descarte precisa substituir uma carta da grade.",
  rules4: "Três cartas iguais viradas para cima em uma coluna desaparecem.",
  rules5:
    "Revele toda a sua grade para encerrar a rodada; os outros jogam uma última vez. Se você não tiver a pontuação estritamente mais baixa, sua pontuação positiva dobra.",
  rules6: "Quando alguém chega a 100 pontos, a partida termina. Vence o menor total.",
  round: "Rodada {n}",
  flipTwo: "Vire 2 cartas",
  lastTurnPill: "Última vez · {name}",
  quit: "Sair para o início",
  confirmLeave: "Sair desta partida?",
  showScores: "Ver pontuação",
  deck: "Monte",
  deckCount: "Monte · {n}",
  drawn: "Comprada",
  drawnCard: "Carta comprada",
  tapToKeep: "Toque para ficar",
  discard: "Descarte",
  discardPile: "Pilha de descarte",
  pts: "{n} pts",
  where: "linha {row}, coluna {col}",
  flipOne: "{name}: vire 1 carta",
  flipMany: "{name}: vire {n} cartas",
  waitingFlip: "Esperando os outros virarem…",
  lastTurn: "Última vez! ",
  draw: "{name}: compre do monte ou pegue o descarte",
  waiting: "Esperando {name}…",
  swapIn: "Toque em uma carta da sua grade para trocar",
  discardMode:
    "Toque em uma carta virada para baixo para virá-la, ou na carta comprada para ficar com ela",
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
  passTo: "Passar para {name} →",
  crashed: "Algo deu errado, então a partida salva foi apagada.",
  startOver: "Recomeçar",
  faceDown: "{label}: virada para baixo",
  empty: "{label}: vazia",
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
