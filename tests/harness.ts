/** A test runner that works under Node and compiled by Perry (no node:test there). */
let passed = 0;
const failures: string[] = [];

export function test(name: string, fn: () => void): void {
  try { fn(); passed++; } catch (err) {
    failures.push(name + ": " + (err instanceof Error ? err.message : String(err)));
  }
}

export function eq(actual: unknown, expected: unknown, what = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}

export function ok(cond: unknown, what = "condition"): void { if (!cond) throw new Error(what + " is false"); }

export function throws(fn: () => void, what = "call"): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(what + " did not throw");
}

/** Print the results; exit non-zero on a failure. */
export function report(suite: string): void {
  for (const f of failures) console.log("FAIL " + f);
  console.log(`${suite}: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}
