import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBucket,
  evaluateBooleanFlag,
  evaluateMissingFlag,
  sanitizeFlagDraft,
  sanitizeTargetingKey
} from "./flags.js";

test("sanitizeFlagDraft normalizes and validates core fields", () => {
  const flag = sanitizeFlagDraft({
    flagKey: " New-Checkout.Enabled ",
    description: " Controls checkout flow ",
    defaultVariant: "off",
    rolloutPercent: 25
  });

  assert.equal(flag.flagKey, "new-checkout.enabled");
  assert.equal(flag.description, "Controls checkout flow");
  assert.equal(flag.defaultVariant, "off");
  assert.equal(flag.rolloutPercent, 25);
});

test("computeBucket is deterministic", () => {
  const a = computeBucket("acct-42", "new-checkout.enabled");
  const b = computeBucket("acct-42", "new-checkout.enabled");
  const c = computeBucket("acct-77", "new-checkout.enabled");

  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 99);
  assert.notEqual(a, c);
});

test("evaluateBooleanFlag respects rollout and default fallback", () => {
  const flag = {
    flagKey: "beta-homepage",
    description: "",
    defaultVariant: "off" as const,
    rolloutPercent: 100,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const result = evaluateBooleanFlag(flag, { targetingKey: "user-123" });
  assert.equal(result.value, true);
  assert.equal(result.variant, "on");
  assert.equal(result.reason, "ROLLOUT");

  const zeroRollout = {
    ...flag,
    rolloutPercent: 0
  };
  const fallbackResult = evaluateBooleanFlag(zeroRollout, { targetingKey: "user-123" });
  assert.equal(fallbackResult.reason, "DEFAULT");
  assert.equal(fallbackResult.variant, "off");
});

test("evaluateMissingFlag returns explicit fallback", () => {
  const off = evaluateMissingFlag();
  const on = evaluateMissingFlag(true);

  assert.equal(off.reason, "FLAG_NOT_FOUND");
  assert.equal(off.variant, "off");
  assert.equal(on.variant, "on");
});

test("sanitizeTargetingKey rejects invalid value types", () => {
  assert.throws(() => sanitizeTargetingKey(12), /invalid_targetingKey/);
  assert.equal(sanitizeTargetingKey("  "), undefined);
  assert.equal(sanitizeTargetingKey("customer-1"), "customer-1");
});
