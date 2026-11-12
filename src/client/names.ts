// Friendly names (M32): the dice by the name field offers "Brave Otter", from each language's
// fixed lists in i18n (`nameAdjectives`, and the characters' own names).
import { CHARACTERS, NAME_MAX } from "../protocol";
import type { Key, T } from "./i18n";

const size = (text: string) => [...text].length;

/** A two-word name in the language of `t`, and the character it names: one no seat in `taken` holds. */
export function friendlyName(
  t: T,
  random = Math.random,
  taken: (number | undefined)[] = [],
): { name: string; char: number } {
  const free = Array.from({ length: CHARACTERS }, (_, i) => i).filter((i) => !taken.includes(i));
  const char = free[Math.floor(random() * free.length)];
  const animal = t(`char${char}` as Key);
  // Only the adjectives that fit beside this animal in a name (and the space between them).
  const fits = t("nameAdjectives")
    .split(" ")
    .filter((adj) => size(adj) + size(animal) < NAME_MAX);
  const adj = fits[Math.floor(random() * fits.length)];
  return { name: t("friendlyName", { adj, animal }), char };
}
