import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateBooleanFlag,
  evaluateMissingFlag,
  normalizeEnvironment,
  normalizeOptionalString,
  normalizeWorkspaceName,
  sanitizeFlagDraft,
  sanitizeTargetingKey,
  type FlagDefinition
} from "./flags.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_BODY_BYTES = 1024 * 1024;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://openfeature-gateway.46.225.49.219.nip.io";
const PAYMENT_URL = process.env.PAYMENT_URL || "https://buy.stripe.com/test_eVq6oH8mqf5WeQJ2jQ";
const PRICE_USD = Number.parseFloat(process.env.PRICE_USD || "19");

const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../site");

const STATIC_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

type EventType =
  | "landing_view"
  | "workspace_created"
  | "flag_saved"
  | "evaluation_requested"
  | "checkout_started"
  | "payment_evidence_submitted"
  | "production_key_issued";

type PaymentProof = {
  submittedAt: string;
  payerEmail: string;
  transactionId: string;
  evidenceUrl?: string;
  note?: string;
};

type Workspace = {
  workspaceId: string;
  workspaceName: string;
  environment: string;
  source: string;
  selfTest: boolean;
  createdAt: string;
  updatedAt: string;
  sandboxApiKey: string;
  productionApiKey?: string;
  paid: boolean;
  flags: Record<string, FlagDefinition>;
  paymentProof?: PaymentProof;
};

type EventRecord = {
  eventId: string;
  eventType: EventType;
  timestamp: string;
  source: string;
  selfTest: boolean;
  workspaceId: string | null;
  details: Record<string, unknown>;
};

type State = {
  workspaces: Record<string, Workspace>;
  events: EventRecord[];
};

type JsonObject = Record<string, unknown>;

type MetricsCounts = Record<EventType, number>;

const EVENT_TYPES: EventType[] = [
  "landing_view",
  "workspace_created",
  "flag_saved",
  "evaluation_requested",
  "checkout_started",
  "payment_evidence_submitted",
  "production_key_issued"
];

const state: State = {
  workspaces: {},
  events: []
};

let stateWriteQueue: Promise<void> = Promise.resolve();
let eventWriteQueue: Promise<void> = Promise.resolve();

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-api-key",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response: http.ServerResponse, statusCode: number, payload: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-api-key",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  response.end(payload);
}

function parseBoolean(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return parseBoolean(value);
}

function normalizeSource(value: unknown, fallback = "web"): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_payload");
  }
  return value as JsonObject;
}

function asRequiredString(payload: JsonObject, key: string, maxLength = 200): string {
  const value = normalizeOptionalString(payload[key], key, maxLength);
  if (!value) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function asOptionalInteger(payload: JsonObject, key: string): number | undefined {
  const raw = payload[key];
  if (raw == null || raw === "") {
    return undefined;
  }
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`invalid_${key}`);
  }
  return parsed;
}

function asOptionalJsonObject(payload: JsonObject, key: string): JsonObject | undefined {
  const raw = payload[key];
  if (raw == null) {
    return undefined;
  }
  return asJsonObject(raw);
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error("invalid_payload_too_large");
    }
    chunks.push(piece);
  }

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return asJsonObject(parsed);
  } catch {
    throw new Error("invalid_json");
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^invalid_[a-zA-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return "unexpected_error";
}

function emptyCounts(): MetricsCounts {
  return {
    landing_view: 0,
    workspace_created: 0,
    flag_saved: 0,
    evaluation_requested: 0,
    checkout_started: 0,
    payment_evidence_submitted: 0,
    production_key_issued: 0
  };
}

function calculateCounts(selfTestFilter?: boolean): MetricsCounts {
  const counts = emptyCounts();
  for (const event of state.events) {
    if (typeof selfTestFilter === "boolean" && event.selfTest !== selfTestFilter) {
      continue;
    }
    counts[event.eventType] += 1;
  }
  return counts;
}

function calculateDailyCounts(selfTestFilter?: boolean): Array<{ date: string; counts: MetricsCounts }> {
  const bucket = new Map<string, MetricsCounts>();

  for (const event of state.events) {
    if (typeof selfTestFilter === "boolean" && event.selfTest !== selfTestFilter) {
      continue;
    }
    const date = event.timestamp.slice(0, 10);
    const counts = bucket.get(date) ?? emptyCounts();
    counts[event.eventType] += 1;
    bucket.set(date, counts);
  }

  return [...bucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, counts }));
}

function createWorkspaceId(): string {
  return `ws_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function createApiKey(prefix: "of_sandbox" | "of_prod"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function normalizeFlagKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("invalid_flagKey");
  }
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error("invalid_flagKey");
  }
  return normalized;
}

function parseSelfTestFilter(raw: string | null): boolean | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  return parseBoolean(raw);
}

function normalizeWorkspaceId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("invalid_workspaceId");
  }
  const normalized = raw.trim();
  if (!/^ws_[a-z0-9]{24}$/.test(normalized)) {
    throw new Error("invalid_workspaceId");
  }
  return normalized;
}

function findWorkspaceByApiKey(apiKey: string):
  | { workspace: Workspace; authMode: "sandbox" | "production" }
  | undefined {
  for (const workspace of Object.values(state.workspaces)) {
    if (workspace.productionApiKey && workspace.productionApiKey === apiKey) {
      return { workspace, authMode: "production" };
    }
    if (workspace.sandboxApiKey === apiKey) {
      return { workspace, authMode: "sandbox" };
    }
  }
  return undefined;
}

function workspacePublicView(workspace: Workspace): Record<string, unknown> {
  return {
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.workspaceName,
    environment: workspace.environment,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    paid: workspace.paid,
    sandboxApiKey: workspace.sandboxApiKey,
    productionApiKey: workspace.productionApiKey,
    flags: Object.values(workspace.flags)
  };
}

async function saveState(): Promise<void> {
  const payload = JSON.stringify(state);
  stateWriteQueue = stateWriteQueue
    .catch(() => undefined)
    .then(() => writeFile(STATE_FILE, payload, "utf8"));
  await stateWriteQueue;
}

async function appendEvent(record: EventRecord): Promise<void> {
  eventWriteQueue = eventWriteQueue
    .catch(() => undefined)
    .then(() => appendFile(EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8"));
  await eventWriteQueue;
}

async function recordEvent(
  eventType: EventType,
  options: {
    source: string;
    selfTest: boolean;
    workspaceId?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const event: EventRecord = {
    eventId: randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    source: options.source,
    selfTest: options.selfTest,
    workspaceId: options.workspaceId ?? null,
    details: options.details ?? {}
  };
  state.events.push(event);
  await Promise.all([saveState(), appendEvent(event)]);
}

async function initStorage(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed && typeof parsed === "object") {
      state.workspaces = parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {};
      state.events = Array.isArray(parsed.events) ? (parsed.events as EventRecord[]) : [];
    }
  } catch {
    await saveState();
  }
}

function getApiKeyFromRequest(request: http.IncomingMessage, payload: JsonObject): string {
  const headerValue = request.headers["x-api-key"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  if (Array.isArray(headerValue) && headerValue.length > 0 && headerValue[0].trim()) {
    return headerValue[0].trim();
  }
  return asRequiredString(payload, "apiKey", 200);
}

async function serveStatic(requestPath: string, response: http.ServerResponse): Promise<boolean> {
  if (requestPath.startsWith("/api/")) {
    return false;
  }

  const relativePath = requestPath === "/" ? "/index.html" : requestPath;
  const resolvedPath = path.normalize(path.join(SITE_DIR, relativePath));
  if (!resolvedPath.startsWith(SITE_DIR)) {
    sendText(response, 400, "Bad request");
    return true;
  }

  try {
    const content = await readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    response.writeHead(200, {
      "content-type": STATIC_MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
      "access-control-allow-origin": "*"
    });
    response.end(content);
    return true;
  } catch {
    if (requestPath === "/" || requestPath === "/index.html") {
      sendText(response, 404, "Not found");
      return true;
    }
    return false;
  }
}

function parseEmail(payload: JsonObject, key: string): string {
  const value = asRequiredString(payload, key, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function parseDefaultValue(payload: JsonObject, key: string): boolean | undefined {
  if (!(key in payload)) {
    return undefined;
  }
  return parseBoolean(payload[key]);
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (!request.url) {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }

  if (request.method === "OPTIONS") {
    sendText(response, 204, "");
    return;
  }

  const url = new URL(request.url, PUBLIC_BASE_URL);
  const pathname = url.pathname;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "openfeature-managed-gateway",
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/metrics") {
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        totals: {
          includingSelfTests: calculateCounts(),
          excludingSelfTests: calculateCounts(false)
        },
        daily: {
          includingSelfTests: calculateDailyCounts(),
          excludingSelfTests: calculateDailyCounts(false)
        },
        workspaces: {
          total: Object.keys(state.workspaces).length,
          paid: Object.values(state.workspaces).filter((workspace) => workspace.paid).length
        }
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/paid-proof/count") {
      const selfTestFilter = parseSelfTestFilter(url.searchParams.get("selfTest"));
      let paidIntakeEvents = 0;
      let paymentEvidenceEvents = 0;

      for (const event of state.events) {
        if (typeof selfTestFilter === "boolean" && event.selfTest !== selfTestFilter) {
          continue;
        }
        if (event.eventType === "checkout_started") {
          paidIntakeEvents += 1;
        }
        if (event.eventType === "payment_evidence_submitted") {
          paymentEvidenceEvents += 1;
        }
      }

      sendJson(response, 200, {
        paidIntakeEvents,
        paymentEvidenceEvents,
        selfTestFilter: typeof selfTestFilter === "boolean" ? selfTestFilter : "all"
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/events/landing") {
      const payload = await readJsonBody(request);
      const source = normalizeSource(payload.source, "web");
      const selfTest = parseBoolean(payload.selfTest);

      await recordEvent("landing_view", {
        source,
        selfTest,
        details: {
          path: normalizeOptionalString(payload.path, "path", 180) || "/",
          referrer: normalizeOptionalString(payload.referrer, "referrer", 300)
        }
      });

      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "POST" && pathname === "/api/workspaces") {
      const payload = await readJsonBody(request);
      const workspaceName = normalizeWorkspaceName(payload.workspaceName);
      const environment = normalizeEnvironment(payload.environment ?? "production");
      const source = normalizeSource(payload.source, "web");
      const selfTest = parseBoolean(payload.selfTest);

      const workspaceId = createWorkspaceId();
      const now = new Date().toISOString();
      const workspace: Workspace = {
        workspaceId,
        workspaceName,
        environment,
        source,
        selfTest,
        createdAt: now,
        updatedAt: now,
        sandboxApiKey: createApiKey("of_sandbox"),
        paid: false,
        flags: {}
      };

      state.workspaces[workspaceId] = workspace;
      await recordEvent("workspace_created", {
        source,
        selfTest,
        workspaceId,
        details: {
          environment,
          workspaceName
        }
      });

      sendJson(response, 201, {
        workspace: workspacePublicView(workspace),
        paywall: {
          priceUsd: PRICE_USD,
          paymentUrl: PAYMENT_URL
        },
        endpoints: {
          evaluate: `${PUBLIC_BASE_URL}/api/openfeature/v1/flags/{flagKey}/evaluate`,
          health: `${PUBLIC_BASE_URL}/api/health`
        },
        snippets: {
          curl: `curl -sS -X POST '${PUBLIC_BASE_URL}/api/openfeature/v1/flags/new-checkout/evaluate' -H 'content-type: application/json' -H 'x-api-key: ${workspace.sandboxApiKey}' --data '{"context":{"targetingKey":"customer-42"},"defaultValue":false}'`
        }
      });
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/workspaces/")) {
      const workspaceId = pathname.split("/").at(-1) || "";
      if (!/^ws_[a-z0-9]{24}$/.test(workspaceId)) {
        throw new Error("invalid_workspaceId");
      }
      const workspace = state.workspaces[workspaceId];
      if (!workspace) {
        sendJson(response, 404, { error: "workspace_not_found" });
        return;
      }

      const apiKey = normalizeOptionalString(url.searchParams.get("apiKey"), "apiKey", 200);
      if (!apiKey || (workspace.sandboxApiKey !== apiKey && workspace.productionApiKey !== apiKey)) {
        sendJson(response, 401, { error: "invalid_apiKey" });
        return;
      }

      sendJson(response, 200, { workspace: workspacePublicView(workspace) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/flags/upsert") {
      const payload = await readJsonBody(request);
      const workspaceId = normalizeWorkspaceId(payload.workspaceId);
      const workspace = state.workspaces[workspaceId];
      if (!workspace) {
        sendJson(response, 404, { error: "workspace_not_found" });
        return;
      }

      const apiKey = asRequiredString(payload, "apiKey", 200);
      if (workspace.sandboxApiKey !== apiKey && workspace.productionApiKey !== apiKey) {
        sendJson(response, 401, { error: "invalid_apiKey" });
        return;
      }

      const defaultVariant = asRequiredString(payload, "defaultVariant", 6);
      if (defaultVariant !== "on" && defaultVariant !== "off") {
        throw new Error("invalid_defaultVariant");
      }
      const rolloutPercent = asOptionalInteger(payload, "rolloutPercent") ?? 0;
      const sanitized = sanitizeFlagDraft({
        flagKey: asRequiredString(payload, "flagKey", 64),
        description: normalizeOptionalString(payload.description, "description", 220),
        defaultVariant,
        rolloutPercent
      });

      const existing = workspace.flags[sanitized.flagKey];
      const now = new Date().toISOString();
      const nextFlag: FlagDefinition = {
        ...sanitized,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      workspace.flags[nextFlag.flagKey] = nextFlag;
      workspace.updatedAt = now;

      const source = normalizeSource(payload.source, workspace.source);
      const selfTest = parseOptionalBoolean(payload.selfTest) ?? workspace.selfTest;

      await recordEvent("flag_saved", {
        source,
        selfTest,
        workspaceId,
        details: {
          flagKey: nextFlag.flagKey,
          rolloutPercent: nextFlag.rolloutPercent,
          defaultVariant: nextFlag.defaultVariant
        }
      });

      sendJson(response, 200, {
        flag: nextFlag,
        workspaceId,
        flagCount: Object.keys(workspace.flags).length
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/evaluate") {
      const payload = await readJsonBody(request);
      const apiKey = asRequiredString(payload, "apiKey", 200);
      const flagKey = normalizeFlagKey(payload.flagKey);
      const source = normalizeSource(payload.source, "web");
      const selfTest = parseBoolean(payload.selfTest);
      const defaultValue = parseDefaultValue(payload, "defaultValue");
      const targetingKey = sanitizeTargetingKey(payload.targetingKey);

      const match = findWorkspaceByApiKey(apiKey);
      if (!match) {
        sendJson(response, 401, { error: "invalid_apiKey" });
        return;
      }

      const workspace = match.workspace;
      if (payload.workspaceId) {
        const workspaceId = normalizeWorkspaceId(payload.workspaceId);
        if (workspace.workspaceId !== workspaceId) {
          sendJson(response, 400, { error: "workspace_mismatch" });
          return;
        }
      }

      const flag = workspace.flags[flagKey];
      const evaluation = flag
        ? evaluateBooleanFlag(flag, { targetingKey })
        : evaluateMissingFlag(defaultValue);

      await recordEvent("evaluation_requested", {
        source,
        selfTest,
        workspaceId: workspace.workspaceId,
        details: {
          flagKey,
          reason: evaluation.reason,
          authMode: match.authMode
        }
      });

      sendJson(response, 200, {
        workspaceId: workspace.workspaceId,
        environment: workspace.environment,
        flagKey,
        value: evaluation.value,
        variant: evaluation.variant,
        reason: evaluation.reason,
        bucket: evaluation.bucket,
        authMode: match.authMode
      });
      return;
    }

    const openFeatureMatch = /^\/api\/openfeature\/v1\/flags\/([a-z0-9._-]+)\/evaluate$/.exec(pathname);
    if (request.method === "POST" && openFeatureMatch) {
      const payload = await readJsonBody(request);
      const apiKey = getApiKeyFromRequest(request, payload);
      const source = normalizeSource(payload.source, "api");
      const selfTest = parseBoolean(payload.selfTest);
      const defaultValue = parseDefaultValue(payload, "defaultValue");
      const context = asOptionalJsonObject(payload, "context");
      const targetingKey = sanitizeTargetingKey(context?.targetingKey ?? payload.targetingKey);
      const flagKey = normalizeFlagKey(openFeatureMatch[1]);

      const match = findWorkspaceByApiKey(apiKey);
      if (!match) {
        sendJson(response, 401, { error: "invalid_apiKey" });
        return;
      }

      const workspace = match.workspace;
      const flag = workspace.flags[flagKey];
      const evaluation = flag
        ? evaluateBooleanFlag(flag, { targetingKey })
        : evaluateMissingFlag(defaultValue);

      await recordEvent("evaluation_requested", {
        source,
        selfTest,
        workspaceId: workspace.workspaceId,
        details: {
          flagKey,
          reason: evaluation.reason,
          authMode: match.authMode,
          endpoint: "openfeature_v1"
        }
      });

      sendJson(response, 200, {
        flagKey,
        value: evaluation.value,
        variant: evaluation.variant,
        reason: evaluation.reason,
        workspaceId: workspace.workspaceId,
        environment: workspace.environment,
        metadata: {
          bucket: evaluation.bucket,
          rolloutPercent: flag?.rolloutPercent ?? 0,
          authMode: match.authMode
        }
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/billing/checkout") {
      const payload = await readJsonBody(request);
      const workspaceId = normalizeWorkspaceId(payload.workspaceId);
      const workspace = state.workspaces[workspaceId];
      if (!workspace) {
        sendJson(response, 404, { error: "workspace_not_found" });
        return;
      }

      const source = normalizeSource(payload.source, workspace.source);
      const selfTest = parseOptionalBoolean(payload.selfTest) ?? workspace.selfTest;

      await recordEvent("checkout_started", {
        source,
        selfTest,
        workspaceId,
        details: {
          priceUsd: PRICE_USD,
          paymentUrl: PAYMENT_URL
        }
      });

      sendJson(response, 200, {
        checkoutMode: "payment_link",
        paymentUrl: PAYMENT_URL,
        priceUsd: PRICE_USD,
        workspaceId
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/billing/proof") {
      const payload = await readJsonBody(request);
      const workspaceId = normalizeWorkspaceId(payload.workspaceId);
      const workspace = state.workspaces[workspaceId];
      if (!workspace) {
        sendJson(response, 404, { error: "workspace_not_found" });
        return;
      }

      const payerEmail = parseEmail(payload, "payerEmail");
      const transactionId = asRequiredString(payload, "transactionId", 120);
      const evidenceUrl = normalizeOptionalString(payload.evidenceUrl, "evidenceUrl", 300);
      const note = normalizeOptionalString(payload.note, "note", 400);
      const source = normalizeSource(payload.source, workspace.source);
      const selfTest = parseOptionalBoolean(payload.selfTest) ?? workspace.selfTest;

      let issuedNewKey = false;
      if (!workspace.productionApiKey) {
        workspace.productionApiKey = createApiKey("of_prod");
        issuedNewKey = true;
      }
      workspace.paid = true;
      workspace.updatedAt = new Date().toISOString();
      workspace.paymentProof = {
        submittedAt: new Date().toISOString(),
        payerEmail,
        transactionId,
        evidenceUrl,
        note
      };

      await recordEvent("payment_evidence_submitted", {
        source,
        selfTest,
        workspaceId,
        details: {
          payerEmail,
          transactionId,
          evidenceUrl,
          note
        }
      });

      if (issuedNewKey) {
        await recordEvent("production_key_issued", {
          source,
          selfTest,
          workspaceId,
          details: {
            productionApiKey: workspace.productionApiKey
          }
        });
      }

      sendJson(response, 200, {
        status: "accepted",
        workspaceId,
        productionApiKey: workspace.productionApiKey,
        issuedNewKey
      });
      return;
    }

    const served = await serveStatic(pathname, response);
    if (served) {
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const code = safeErrorCode(error);
    const statusCode = code.startsWith("invalid_") ? 400 : 500;
    sendJson(response, statusCode, { error: code });
  }
}

await initStorage();

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      status: "listening",
      host: HOST,
      port: PORT,
      dataDir: DATA_DIR,
      publicBaseUrl: PUBLIC_BASE_URL
    })
  );
});
