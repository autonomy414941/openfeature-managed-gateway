const workspaceForm = document.querySelector("#workspace-form");
const flagForm = document.querySelector("#flag-form");
const evalForm = document.querySelector("#eval-form");
const proofForm = document.querySelector("#proof-form");

const workspaceBtn = document.querySelector("#workspace-btn");
const flagBtn = document.querySelector("#flag-btn");
const evalBtn = document.querySelector("#eval-btn");
const checkoutBtn = document.querySelector("#checkout-btn");
const proofBtn = document.querySelector("#proof-btn");

const workspaceStatus = document.querySelector("#workspace-status");
const flagStatus = document.querySelector("#flag-status");
const evalStatus = document.querySelector("#eval-status");
const billingStatus = document.querySelector("#billing-status");

const workspaceResult = document.querySelector("#workspace-result");
const flagSection = document.querySelector("#flag-section");
const evalSection = document.querySelector("#eval-section");
const billingSection = document.querySelector("#billing-section");

const workspaceIdEl = document.querySelector("#workspace-id");
const sandboxKeyEl = document.querySelector("#sandbox-key");
const productionKeyEl = document.querySelector("#production-key");
const evalOutput = document.querySelector("#eval-output");
const curlOutput = document.querySelector("#curl-output");

const query = new URLSearchParams(window.location.search);
const source = query.get("source") || query.get("utm_source") || query.get("ref") || "web";
const selfTest = ["1", "true", "yes"].includes((query.get("selfTest") || "").toLowerCase());

let workspaceId = null;
let sandboxApiKey = null;
let productionApiKey = null;
let paymentUrl = null;

function setStatus(target, message, tone = "neutral") {
  target.textContent = message;
  target.dataset.tone = tone;
}

async function jsonRequest(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data && typeof data.error === "string" ? data.error : `http_${response.status}`;
    throw new Error(code);
  }
  return data;
}

function requireWorkspace() {
  if (!workspaceId || !sandboxApiKey) {
    throw new Error("workspace_not_ready");
  }
}

function buildEvalCurl(flagKey, targetingKey, defaultValue, apiKey) {
  return [
    `curl -sS -X POST '${window.location.origin}/api/openfeature/v1/flags/${flagKey}/evaluate' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'x-api-key: ${apiKey}' \\`,
    `  --data '{"context":{"targetingKey":"${targetingKey}"},"defaultValue":${defaultValue}}'`
  ].join("\n");
}

async function trackLanding() {
  try {
    await jsonRequest("/api/events/landing", {
      source,
      selfTest,
      path: window.location.pathname,
      referrer: document.referrer || ""
    });
  } catch {
    // Ignore analytics failures for UX.
  }
}

workspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  workspaceBtn.disabled = true;
  setStatus(workspaceStatus, "Creating workspace...", "neutral");

  try {
    const formData = new FormData(workspaceForm);
    const data = await jsonRequest("/api/workspaces", {
      workspaceName: String(formData.get("workspaceName") || "").trim(),
      environment: String(formData.get("environment") || "production").trim(),
      source,
      selfTest
    });

    workspaceId = data?.workspace?.workspaceId || null;
    sandboxApiKey = data?.workspace?.sandboxApiKey || null;
    productionApiKey = data?.workspace?.productionApiKey || null;
    paymentUrl = data?.paywall?.paymentUrl || null;

    workspaceIdEl.textContent = workspaceId || "-";
    sandboxKeyEl.textContent = sandboxApiKey || "-";
    productionKeyEl.textContent = productionApiKey || "(locked)";

    workspaceResult.classList.remove("hidden");
    flagSection.classList.remove("hidden");
    evalSection.classList.remove("hidden");
    billingSection.classList.remove("hidden");

    setStatus(workspaceStatus, "Workspace ready. Save your first flag.", "ok");
    setStatus(flagStatus, "Define a flag and rollout split.", "neutral");
    setStatus(billingStatus, "Checkout is available.", "neutral");
  } catch (error) {
    setStatus(workspaceStatus, `Could not create workspace: ${error.message}`, "error");
  } finally {
    workspaceBtn.disabled = false;
  }
});

flagForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  flagBtn.disabled = true;
  setStatus(flagStatus, "Saving flag...", "neutral");

  try {
    requireWorkspace();
    const formData = new FormData(flagForm);
    const data = await jsonRequest("/api/flags/upsert", {
      workspaceId,
      apiKey: sandboxApiKey,
      flagKey: String(formData.get("flagKey") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      defaultVariant: String(formData.get("defaultVariant") || "off"),
      rolloutPercent: Number(formData.get("rolloutPercent") || 0),
      source,
      selfTest
    });

    const flag = data?.flag?.flagKey || "flag";
    setStatus(flagStatus, `Saved ${flag}. Run an evaluation call.`, "ok");
  } catch (error) {
    setStatus(flagStatus, `Could not save flag: ${error.message}`, "error");
  } finally {
    flagBtn.disabled = false;
  }
});

evalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  evalBtn.disabled = true;
  setStatus(evalStatus, "Evaluating...", "neutral");

  try {
    requireWorkspace();
    const formData = new FormData(evalForm);
    const flagKey = String(formData.get("flagKey") || "").trim();
    const targetingKey = String(formData.get("targetingKey") || "").trim();
    const defaultValue = String(formData.get("defaultValue") || "false") === "true";

    const data = await jsonRequest("/api/evaluate", {
      workspaceId,
      apiKey: sandboxApiKey,
      flagKey,
      targetingKey,
      defaultValue,
      source,
      selfTest
    });

    evalOutput.textContent = JSON.stringify(data, null, 2);
    curlOutput.textContent = buildEvalCurl(flagKey, targetingKey || "customer-42", defaultValue, sandboxApiKey);
    setStatus(evalStatus, "Evaluation complete. Use the curl snippet in your app integration.", "ok");
  } catch (error) {
    setStatus(evalStatus, `Evaluation failed: ${error.message}`, "error");
    evalOutput.textContent = "";
    curlOutput.textContent = "";
  } finally {
    evalBtn.disabled = false;
  }
});

checkoutBtn.addEventListener("click", async () => {
  checkoutBtn.disabled = true;
  setStatus(billingStatus, "Preparing checkout...", "neutral");

  try {
    requireWorkspace();
    const data = await jsonRequest("/api/billing/checkout", {
      workspaceId,
      source,
      selfTest
    });

    const url = data?.paymentUrl || paymentUrl;
    if (!url) {
      throw new Error("missing_payment_url");
    }

    window.open(url, "_blank", "noopener,noreferrer");
    setStatus(billingStatus, "Checkout opened. Submit proof once payment is complete.", "ok");
  } catch (error) {
    setStatus(billingStatus, `Checkout failed: ${error.message}`, "error");
  } finally {
    checkoutBtn.disabled = false;
  }
});

proofForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  proofBtn.disabled = true;
  setStatus(billingStatus, "Submitting payment proof...", "neutral");

  try {
    requireWorkspace();
    const formData = new FormData(proofForm);
    const data = await jsonRequest("/api/billing/proof", {
      workspaceId,
      payerEmail: String(formData.get("payerEmail") || "").trim(),
      transactionId: String(formData.get("transactionId") || "").trim(),
      evidenceUrl: String(formData.get("evidenceUrl") || "").trim(),
      note: String(formData.get("note") || "").trim(),
      source,
      selfTest
    });

    productionApiKey = data?.productionApiKey || productionApiKey;
    productionKeyEl.textContent = productionApiKey || "(locked)";
    setStatus(billingStatus, "Payment proof accepted. Production key unlocked.", "ok");
  } catch (error) {
    setStatus(billingStatus, `Payment proof failed: ${error.message}`, "error");
  } finally {
    proofBtn.disabled = false;
  }
});

void trackLanding();
