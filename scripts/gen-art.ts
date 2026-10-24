// Generates the original card art with Gemini and writes WebP files to src/client/art/.
// Local only: needs GEMINI_API_KEY in .env and ffmpeg on PATH. Never run in CI.
// Usage: npm run art [-- name ...]   (no names = only missing files; names = regenerate those)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";
const OUT = "src/client/art";
const WIDTH = 480;

const STYLE =
  "Flat layered paper-cut illustration with soft grain, gentle depth shadows between layers. " +
  "Portrait card artwork filling the whole frame edge to edge, no border, no frame. " +
  "Absolutely no text, letters, digits, numbers, symbols, logos or watermarks. " +
  "Keep the central area calm and low-contrast so a large numeral can sit on top of it.";

const band = (palette: string, motif: string) => `${motif}, in ${palette}. ${STYLE}`;

const ART: Record<string, string> = {
  back:
    "Symmetric card back: a stylized mountain range under a big compass-rose star, " +
    "concentric arcs like topographic lines, deep navy, teal and warm gold. " +
    STYLE.replace(
      " Keep the central area calm and low-contrast so a large numeral can sit on top of it.",
      "",
    ),
  "band-neg": band(
    "deep indigo and violet",
    "Quiet night valley with a crescent moon and tiny stars",
  ),
  "band-zero": band("aqua and pale cyan", "Still mountain lake with ripples at dawn"),
  "band-low": band("fresh greens and mint", "Rolling meadow hills with a few round trees"),
  "band-mid": band("warm yellows and amber", "Sunny wheat-field hills under a low sun"),
  "band-high": band("coral, red and orange", "Volcanic ridges at sunset with drifting embers"),
};

async function generate(prompt: string, key: string): Promise<Buffer> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "2:3" } },
      }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error?.message ?? "unknown error"}`);
  const parts: { inlineData?: { data: string } }[] = body.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData)?.inlineData?.data;
  if (!image) throw new Error("No image in response");
  return Buffer.from(image, "base64");
}

process.loadEnvFile(".env");
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY missing from .env");
const requested = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), "art-"));

for (const [name, prompt] of Object.entries(ART)) {
  const out = join(OUT, `${name}.webp`);
  if (requested.length ? !requested.includes(name) : existsSync(out)) continue;
  console.log(`generating ${name}…`);
  const png = join(tmp, `${name}.png`);
  writeFileSync(png, await generate(prompt, key));
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    png,
    "-vf",
    `scale=${WIDTH}:-2`,
    "-quality",
    "80",
    out,
  ]);
  console.log(`  wrote ${out}`);
}
