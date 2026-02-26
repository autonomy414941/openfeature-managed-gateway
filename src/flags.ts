export type Variant = "on" | "off";

export type FlagDraft = {
  flagKey: string;
  description?: string;
  defaultVariant: Variant;
  rolloutPercent: number;
};

export type FlagDefinition = {
  flagKey: string;
  description?: string;
  defaultVariant: Variant;
  rolloutPercent: number;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationInput = {
  targetingKey?: string;
  fallbackValue?: boolean;
};

export type EvaluationResult = {
  value: boolean;
  variant: Variant;
  reason: "ROLLOUT" | "DEFAULT" | "FLAG_NOT_FOUND";
  bucket: number | null;
};

function normalizeCompactText(value: string, key: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`invalid_${key}`);
  }
  return normalized;
}

function normalizeFlagKey(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error("invalid_flagKey");
  }
  return normalized;
}

function normalizeVariant(raw: string): Variant {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") {
    return normalized;
  }
  throw new Error("invalid_defaultVariant");
}

function normalizeRolloutPercent(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 100) {
    throw new Error("invalid_rolloutPercent");
  }
  return raw;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function computeBucket(targetingKey: string, flagKey: string): number {
  const seed = `${targetingKey}:${flagKey}`;
  return fnv1a32(seed) % 100;
}

export function sanitizeFlagDraft(input: FlagDraft): Omit<FlagDefinition, "createdAt" | "updatedAt"> {
  if (!input || typeof input !== "object") {
    throw new Error("invalid_flag");
  }

  const flagKey = normalizeFlagKey(input.flagKey);
  const defaultVariant = normalizeVariant(input.defaultVariant);
  const rolloutPercent = normalizeRolloutPercent(input.rolloutPercent);
  const description =
    typeof input.description === "string" && input.description.trim()
      ? normalizeCompactText(input.description, "description", 220)
      : undefined;

  return {
    flagKey,
    description,
    defaultVariant,
    rolloutPercent
  };
}

export function sanitizeTargetingKey(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("invalid_targetingKey");
  }
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > 120) {
    throw new Error("invalid_targetingKey");
  }
  return normalized;
}

export function evaluateBooleanFlag(
  flag: FlagDefinition,
  input: EvaluationInput
): EvaluationResult {
  const targetingKey = sanitizeTargetingKey(input.targetingKey);

  if (!targetingKey) {
    const value = flag.defaultVariant === "on";
    return {
      value,
      variant: value ? "on" : "off",
      reason: "DEFAULT",
      bucket: null
    };
  }

  const bucket = computeBucket(targetingKey, flag.flagKey);
  if (bucket < flag.rolloutPercent) {
    return {
      value: true,
      variant: "on",
      reason: "ROLLOUT",
      bucket
    };
  }

  const value = flag.defaultVariant === "on";
  return {
    value,
    variant: value ? "on" : "off",
    reason: "DEFAULT",
    bucket
  };
}

export function evaluateMissingFlag(fallbackValue?: boolean): EvaluationResult {
  const value = fallbackValue === true;
  return {
    value,
    variant: value ? "on" : "off",
    reason: "FLAG_NOT_FOUND",
    bucket: null
  };
}

export function normalizeWorkspaceName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("invalid_workspaceName");
  }
  return normalizeCompactText(raw, "workspaceName", 80);
}

export function normalizeEnvironment(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("invalid_environment");
  }
  return normalizeCompactText(raw, "environment", 40).toLowerCase();
}

export function normalizeOptionalString(raw: unknown, key: string, maxLength = 200): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`invalid_${key}`);
  }
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > maxLength) {
    throw new Error(`invalid_${key}`);
  }
  return normalized;
}
