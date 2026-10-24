import { describe, expect, it } from "vitest";
import { type Key, LOCALES, translator } from "./i18n";

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

  it("fills placeholders", () => {
    expect(translator("es")("passTo", { name: "Ana" })).toBe("Pasar a Ana →");
    expect(translator("pt")("round", { n: 3 })).toBe("Rodada 3");
  });
});
