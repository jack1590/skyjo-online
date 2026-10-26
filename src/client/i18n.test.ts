import { describe, expect, it } from "vitest";
import { type Key, LOCALES, ordinal, translator } from "./i18n";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("every translation uses the same placeholders as English", () => {
    const en: Record<Key, string> = LOCALES.en.dict;
    for (const { dict } of Object.values(LOCALES)) {
      const d: Record<Key, string> = dict;
      for (const key of Object.keys(en) as Key[]) {
        expect([key, placeholders(d[key])]).toEqual([key, placeholders(en[key])]);
      }
    }
  });

  it("UX-17: places are ordinals in each language (en 1st 2nd 3rd, es 2.º 3.er, pt 2º)", () => {
    const places = [1, 2, 3, 4, 8, 11, 12, 13, 21, 22, 23];
    expect(places.map((n) => ordinal("en", n))).toEqual(
      "1st 2nd 3rd 4th 8th 11th 12th 13th 21st 22nd 23rd".split(" "),
    );
    expect(translator("es")("youPlaced", { n: ordinal("es", 2) })).toBe("Quedaste en 2.º lugar");
    expect([1, 3, 4].map((n) => ordinal("es", n))).toEqual(["1.er", "3.er", "4.º"]);
    expect(translator("pt")("youPlaced", { n: ordinal("pt", 3) })).toBe("Você ficou em 3º lugar");
  });

  it("fills placeholders", () => {
    expect(translator("es")("showCards", { name: "Ana" })).toBe("Ver las cartas de Ana");
    expect(translator("pt")("round", { n: 3 })).toBe("Rodada 3");
  });
});
