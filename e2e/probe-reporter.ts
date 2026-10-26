// Probe only (m20-ci-probe): prints each table test's steps with their durations, so CI's slow
// step shows.
import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

export default class Probe implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    if (!test.location.file.endsWith("table.spec.ts") || result.status === "skipped") return;
    const lines: string[] = [];
    const walk = (steps: TestStep[], depth: number) => {
      for (const s of steps) {
        if (s.duration >= 100 || depth === 1)
          lines.push(`${"  ".repeat(depth)}${s.duration}ms ${s.category} ${s.title.slice(0, 90)}`);
        walk(s.steps, depth + 1);
      }
    };
    walk(result.steps, 1);
    console.log(`PROBE ${result.duration}ms ${test.title.slice(0, 70)}\n${lines.join("\n")}`);
  }
}
