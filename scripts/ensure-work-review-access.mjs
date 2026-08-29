const endpoint = "https://api.cloudflare.com/client/v4";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "d20586cf099d39fcbeb5db4043e20f6f";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
const domain = "review.tolanimediagroup.com";
const appName = "TMG Work Request Review Console";
const policyName = "Allow Tolani Cloudflare account operators";

function fail(message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

async function cf(path, init = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const detail = body.errors?.map((item) => item.message).join("; ") || response.statusText;
    throw new Error(`${path} failed (${response.status}): ${detail}`);
  }
  return body.result;
}

async function listApps() {
  const apps = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await cf(`/accounts/${accountId}/access/apps?per_page=100&page=${page}`);
    apps.push(...(result || []));
    if (!result?.length || result.length < 100) break;
  }
  return apps;
}

async function listPolicies(appId) {
  const result = await cf(`/accounts/${accountId}/access/apps/${appId}/policies?per_page=100&page=1`);
  return result || [];
}

if (!token) fail("CLOUDFLARE_API_TOKEN is required.");

let apps;
try {
  apps = await listApps();
} catch (error) {
  fail("Unable to inspect Cloudflare Access applications.", {
    detail: error instanceof Error ? error.message : String(error),
    permissionHint: "The token needs Access: Apps and Policies Read/Write for this account.",
  });
}

const desiredApp = {
  name: appName,
  type: "self_hosted",
  domain,
  self_hosted_domains: [domain, `${domain}/*`],
  session_duration: "12h",
  app_launcher_visible: false,
  http_only_cookie_attribute: true,
  same_site_cookie_attribute: "lax",
  enable_binding_cookie: true,
  custom_deny_message: "TMG Work Review is restricted to approved Tolani operators.",
};

let app = apps.find((candidate) => candidate.name === appName || candidate.domain === domain);
try {
  if (!app) {
    app = await cf(`/accounts/${accountId}/access/apps`, { method: "POST", body: JSON.stringify(desiredApp) });
  } else {
    app = await cf(`/accounts/${accountId}/access/apps/${app.id}`, { method: "PUT", body: JSON.stringify(desiredApp) });
  }
} catch (error) {
  fail("Unable to create or update the TMG Work Review Access application.", {
    detail: error instanceof Error ? error.message : String(error),
    permissionHint: "The token needs Access: Apps and Policies Write.",
  });
}

let policies;
try {
  policies = await listPolicies(app.id);
} catch (error) {
  fail("Unable to inspect TMG Work Review Access policies.", { detail: error instanceof Error ? error.message : String(error) });
}

const desiredPolicy = {
  name: policyName,
  decision: "allow",
  precedence: 1,
  session_duration: "12h",
  purpose_justification_required: true,
  purpose_justification_prompt: "Enter the operating need for this TMG work-request review session.",
  include: [{ cloudflare_account_member: { account_id: accountId } }],
};

const policy = policies.find((candidate) => candidate.name === policyName);
try {
  if (policy) {
    await cf(`/accounts/${accountId}/access/apps/${app.id}/policies/${policy.id}`, {
      method: "PUT",
      body: JSON.stringify(desiredPolicy),
    });
  } else {
    await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
      method: "POST",
      body: JSON.stringify(desiredPolicy),
    });
  }
} catch (error) {
  fail("Unable to apply the TMG Work Review Access policy.", {
    detail: error instanceof Error ? error.message : String(error),
    permissionHint: "Cloudflare account-member Access requires a Cloudflare identity provider and Access policy write permission.",
  });
}

console.log(JSON.stringify({
  ok: true,
  application: {
    id: app.id,
    uid: app.uid || app.id,
    name: app.name,
    domain: app.domain,
    aud: app.aud || null,
    type: app.type,
  },
  policy: {
    name: policyName,
    decision: "allow",
    selector: "cloudflare_account_member",
    accountId,
  },
}, null, 2));
