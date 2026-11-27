/**
 * Test assertions that `node:assert` lacks, so the suite runs unchanged on
 * Deno, Bun and Node. `rejected` and `thrown` stand in for the value-returning
 * `assertRejects` and `assertThrows` of `@std/assert`. This file is a test
 * helper and is not published (`src/postgres/testing/` is excluded).
 */
import assert from "node:assert/strict";

type ErrorClass<T extends Error> = abstract new (...args: never[]) => T;

/** thrown calls `callback` and returns the Error it throws. */
export function thrown<T extends Error = Error>(
  callback: () => unknown,
  errorClass?: ErrorClass<T>,
  messageIncludes?: string,
): T {
  let caught: unknown;
  let didThrow = false;
  try {
    callback();
  } catch (error) {
    didThrow = true;
    caught = error;
  }
  assert.ok(didThrow, "Expected function to throw");
  return check(caught, errorClass, messageIncludes);
}

/** rejected awaits the promise `callback` returns and returns its rejection. */
export async function rejected<T extends Error = Error>(
  callback: () => Promise<unknown>,
  errorClass?: ErrorClass<T>,
  messageIncludes?: string,
): Promise<T> {
  let caught: unknown;
  let didReject = false;
  try {
    await callback();
  } catch (error) {
    didReject = true;
    caught = error;
  }
  assert.ok(didReject, "Expected function to reject");
  return check(caught, errorClass, messageIncludes);
}

function check<T extends Error>(
  caught: unknown,
  errorClass: ErrorClass<T> | undefined,
  messageIncludes: string | undefined,
): T {
  const expected = errorClass ?? Error;
  assert.ok(
    caught instanceof expected,
    `Expected error to be an instance of ${expected.name}: ${String(caught)}`,
  );
  const error = caught as T;
  if (messageIncludes !== undefined) {
    assert.ok(
      error.message.includes(messageIncludes),
      `Expected error message to include "${messageIncludes}": ${error.message}`,
    );
  }
  return error;
}

/** assertStringIncludes checks that `actual` contains `expected`. */
export function assertStringIncludes(actual: string, expected: string): void {
  assert.ok(
    actual.includes(expected),
    `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
  );
}

/**
 * assertAlmostEquals checks that two numbers differ by at most `tolerance`
 * (an absolute difference). The ported tests passed `6` to std's version,
 * which reads the argument as a tolerance, not as decimal places, so those
 * checks accepted any score within 6; they now hold to 1e-6 as intended.
 */
export function assertAlmostEquals(
  actual: number,
  expected: number,
  tolerance = 1e-6,
): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}
