import { readFile } from "node:fs/promises";

const paths = {
  html: "ui/index.html",
  css: "ui/app.css",
  js: "ui/app.js",
  headers: "ui/_headers",
  wrangler: "wrangler.jsonc",
  worker: "src/index.ts",
  bootstrap: "src/ui-bootstrap.ts",
  publicContext: "config/public-product-context.json",
  releaseAuthority: "config/production-release-authority.json",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [html, css, js, headers, wranglerText, worker, bootstrap, publicContextText, releaseAuthorityText] = await Promise.all(
    Object.values(paths).map((path) => readFile(path, "utf8")),
  );
  const publicContext = JSON.parse(publicContextText);
  const releaseAuthority = JSON.parse(releaseAuthorityText);
  const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, ""));

  assert(publicContext.publicStatus === "G0", "UI integrity requires the current G0 public-context gate");
  assert(html.includes(publicContext.valueProposition), "UI must render the governed TMG value proposition verbatim");
  assert(html.includes("G0 · Internal prototype"), "UI must disclose G0/internal-prototype status");
  assert(html.includes("No public commercial authority"), "UI footer must disclose missing public commercial authority");

  for (const prohibited of publicContext.prohibitedClaims ?? []) {
    assert(!html.includes(prohibited), `UI contains prohibited public claim: ${prohibited}`);
  }

  assert(!/<script[^>]*>\s*[^<]/i.test(html), "Inline executable scripts are not allowed");
  assert(!/<style[\s>]/i.test(html), "Inline style blocks are not allowed");
  assert(!/https?:\/\//i.test(html), "UI HTML must not load third-party resources");
  assert(!/https?:\/\//i.test(css), "UI CSS must not load third-party resources");
  assert(!/https?:\/\//i.test(js), "UI JavaScript must not call third-party resources");
  assert(!/\.innerHTML\b/.test(js), "UI JavaScript must avoid innerHTML injection sinks");
  assert(js.includes('const BOOTSTRAP_ENDPOINT = "/v1/ui/bootstrap"'), "UI may fetch only the governed bootstrap endpoint");
  assert(!/fetch\((?!BOOTSTRAP_ENDPOINT)/.test(js), "Unexpected fetch call detected in UI JavaScript");

  assert(js.includes('schema: "tmg.request-manifest.draft.v1"'), "Request manifest schema is missing");
  assert(js.includes("submissionAuthority: false"), "Local request manifest must deny submission authority");
  assert(js.includes("fileTransferAuthority: false"), "Local request manifest must deny file-transfer authority");
  assert(js.includes("fileBytesIncluded: false"), "Local request manifest must explicitly exclude file bytes");

  assert(headers.includes("Content-Security-Policy:"), "Static asset CSP is missing");
  assert(headers.includes("X-Frame-Options: DENY"), "Clickjacking protection is missing");
  assert(headers.includes("X-Robots-Tag: noindex, nofollow, noarchive"), "G0 UI must remain noindex");

  assert(wrangler.compatibility_date === "2026-08-24", "Wrangler compatibility date must be current for this UI increment");
  assert(wrangler.assets?.directory === "./ui", "Workers Static Assets directory must be ./ui");
  assert(wrangler.assets?.binding === "ASSETS", "Workers Static Assets binding must be ASSETS");
  assert(wrangler.assets?.not_found_handling === "single-page-application", "UI must use SPA fallback handling");
  assert(Array.isArray(wrangler.assets?.run_worker_first), "Worker-first API route list is required");
  for (const route of ["/health", "/v1/*", "/mcp*"]) {
    assert(wrangler.assets.run_worker_first.includes(route), `Worker-first route missing: ${route}`);
  }

  assert(worker.includes('url.pathname === "/v1/ui/bootstrap"'), "Worker UI bootstrap route is missing");
  assert(worker.includes("buildUiBootstrap(env)"), "Worker UI bootstrap projection is missing");
  assert(bootstrap.includes('publicStatusGate: "G0"'), "Bootstrap must preserve G0 status");
  assert(bootstrap.includes("submissionAuthority: false"), "Bootstrap must deny intake submission authority");

  assert(releaseAuthority.status === "s0_s1_implemented_unactivated", "Release authority status changed unexpectedly");
  assert(releaseAuthority.authority.activationAuthorized === false, "UI increment cannot activate production authority");
  assert(releaseAuthority.authority.publicTrafficAuthorized === false, "UI increment cannot authorize public traffic");
  assert(releaseAuthority.authority.commercialUseAuthorized === false, "UI increment cannot authorize commercial use");

  console.log("TMG enterprise UI integrity: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
