// Characters (M32): each seat's sticker, an animal's head on a disc of its own colour. A seat's
// character is its index here (`SeatView.char`); the order is the protocol, so only append.
import type { CSSProperties } from "react";
import axolotl from "./art/char-axolotl.webp";
import bear from "./art/char-bear.webp";
import cat from "./art/char-cat.webp";
import fox from "./art/char-fox.webp";
import frog from "./art/char-frog.webp";
import koala from "./art/char-koala.webp";
import lion from "./art/char-lion.webp";
import octopus from "./art/char-octopus.webp";
import otter from "./art/char-otter.webp";
import owl from "./art/char-owl.webp";
import panda from "./art/char-panda.webp";
import penguin from "./art/char-penguin.webp";
import rabbit from "./art/char-rabbit.webp";
import raccoon from "./art/char-raccoon.webp";
import toucan from "./art/char-toucan.webp";
import wolf from "./art/char-wolf.webp";
import { type Key, useI18n } from "./i18n";

/** The head and its disc's colour, picked to set the animal off. `char0`… in i18n name them. */
export const CHARS: [src: string, color: string][] = [
  [fox, "#1fa3a3"],
  [otter, "#4aa8e8"],
  [owl, "#4b3fb0"],
  [cat, "#f2b632"],
  [panda, "#3fae5a"],
  [frog, "#e8589a"],
  [penguin, "#e04f4f"],
  [lion, "#8a4fd0"],
  [koala, "#c2409a"],
  [axolotl, "#2f5fd0"],
  [raccoon, "#9bc53d"],
  [wolf, "#f08a24"],
  [toucan, "#5fd0a8"],
  [octopus, "#f6d860"],
  [bear, "#5b6b82"],
  [rabbit, "#9a6238"],
];

export const charKey = (char: number) => `char${char}` as Key;

const disc = (char: number): CSSProperties => ({
  backgroundColor: CHARS[char][1],
  backgroundImage: `url(${CHARS[char][0]})`,
});

/**
 * A seat's face: its character, in both looks; without one (a tab from before 2.14.0), the
 * monogram disc in the seat's own colour (M28), which only the Modern look draws (styles.css).
 */
export function Avatar({ seat, name, char }: { seat: number; name: string; char?: number }) {
  // A number this build doesn't know (a later one's character): the monogram.
  if (char !== undefined && CHARS[char]) {
    return <span className="av char" data-char={char} style={disc(char)} aria-hidden="true" />;
  }
  return (
    <span
      className={`av av-${seat}`}
      data-initial={[...name.trim()][0]?.toUpperCase()}
      aria-hidden="true"
    />
  );
}

interface PickerProps {
  /** The one picked, if any. */
  value?: number;
  /** Characters other seats hold: shown, not offered. */
  taken: (number | undefined)[];
  onPick: (char: number) => void;
}

/** All the characters, a 44 px button each. */
export function CharacterPicker({ value, taken, onPick }: PickerProps) {
  const { t } = useI18n();
  return (
    <fieldset className="chars" data-testid="characters">
      <legend>{t("pickCharacter")}</legend>
      {CHARS.map(([src], char) => (
        <button
          type="button"
          key={src}
          className="char-pick"
          style={disc(char)}
          aria-label={t(charKey(char))}
          aria-pressed={value === char}
          disabled={value !== char && taken.includes(char)}
          onClick={() => onPick(char)}
        />
      ))}
    </fieldset>
  );
}
