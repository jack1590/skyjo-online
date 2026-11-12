import { describe, expect, it } from "vitest";
import { CHARACTERS, cutName, NAME_MAX } from "../protocol";
import { cleanName } from "../server/room";
import { LOCALES, type Locale, translator } from "./i18n";
import { friendlyName } from "./names";

/** Every name the dice can offer in a language: each animal with each adjective that fits it. */
function all(locale: Locale) {
  const t = translator(locale);
  const names: { name: string; char: number }[] = [];
  for (let char = 0; char < CHARACTERS; char++) {
    // 40 steps cover every adjective: no list is that long.
    for (let i = 0; i < 40; i++) {
      const rolls = [char / CHARACTERS, i / 40];
      names.push(friendlyName(t, () => rolls.shift() ?? 0));
    }
  }
  return names;
}

describe("friendly names (M32)", () => {
  it("every name fits the name limit and is kept as it is by the server, in en, es and pt", () => {
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      for (const { name } of all(locale)) {
        expect([...name].length, name).toBeLessThanOrEqual(NAME_MAX);
        expect(cutName(name)).toBe(name);
        expect(cleanName(name)).toBe(name);
        expect(name).toMatch(/^\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+$/u);
      }
    }
  });

  it("each language has 16 animals and at least 8 adjectives that fit each one", () => {
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const names = all(locale);
      expect(new Set(names.map((n) => n.char)).size).toBe(CHARACTERS);
      for (let char = 0; char < CHARACTERS; char++) {
        const mine = new Set(names.filter((n) => n.char === char).map((n) => n.name));
        expect(mine.size, `${locale} ${char}`).toBeGreaterThanOrEqual(8);
      }
      // No word twice in a list.
      const adjectives = translator(locale)("nameAdjectives").split(" ");
      expect(new Set(adjectives).size).toBe(adjectives.length);
    }
  });

  it("names its character, in the language's word order", () => {
    const first = () => 0;
    expect(friendlyName(translator("en"), first)).toEqual({ name: "Brave Fox", char: 0 });
    expect(friendlyName(translator("es"), first)).toEqual({ name: "Zorro Valiente", char: 0 });
    expect(friendlyName(translator("pt"), first)).toEqual({ name: "Raposa Valente", char: 0 });
    const otter = [1 / CHARACTERS, 0];
    expect(friendlyName(translator("es"), () => otter.shift() ?? 0).name).toBe("Nutria Valiente");
  });
});
