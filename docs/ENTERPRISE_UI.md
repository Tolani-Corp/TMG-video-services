# TMG Enterprise UI / UX v1

## Purpose

This increment adds an enterprise-grade internal control surface to TMG Video Services without changing the repository's G0 commercial or production authority.

The interface is intentionally an **operational prototype**, not a representation that TMG has launched a public SaaS product. It consumes the existing governed architecture and exposes only secret-free state.

## Information architecture

The UI has four primary surfaces:

1. **Overview** — governed value proposition, architecture path, current G0 posture, and safe runtime signals.
2. **Request Builder** — checklist-driven production brief, local file metadata references, rights acknowledgement, desired output intents, and output profile.
3. **Operations** — live Worker bootstrap state for public API, MCP, ingestion Workflow, provider egress, embedding profile, policy version, and usage ledger.
4. **Governance** — S0-S5 release rail, rights/lineage principles, and zero-tolerance hard-stop conditions.

## Request manifest boundary

The request builder currently creates `tmg.request-manifest.draft.v1` only.

At G0:

- raw file bytes remain in the browser;
- selected files are represented by local metadata only (`name`, `size`, `type`, `lastModified`);
- browser localStorage is used only for draft convenience;
- the UI can export a JSON manifest;
- backend submission is disabled;
- file transfer is disabled;
- processing authority is false;
- publication authority is false;
- commercial authority is false.

Future authenticated intake must be a separate governed increment. The existence of this request UI does not create upload, processing, billing, publication, licensing, or commercial authority.

## Runtime bootstrap

`GET /v1/ui/bootstrap` returns a bounded projection of non-secret state:

- G0 product gate;
- policy version;
- embedding provider ID and dimensions;
- public API flag;
- MCP flag;
- ingestion Workflow flag;
- external-provider egress flag;
- provider acceptance state;
- tenant usage-ledger flag;
- immutable release-authority boundaries for this UI increment.

A runtime configuration flag can be true without release authority becoming true. The bootstrap intentionally models those concepts separately.

## Cloudflare deployment model

The UI uses Workers Static Assets from `./ui` with an `ASSETS` binding and SPA fallback. Worker-first routes are limited to:

- `/health`
- `/v1/*`
- `/mcp*`

Static assets therefore stay on Cloudflare's asset path while API/control routes continue through `src/index.ts`.

The compatibility date is advanced to `2026-08-24` and `nodejs_compat` remains enabled.

## Security posture

`ui/_headers` applies:

- Content Security Policy with same-origin scripts, styles, fonts, and connections;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- no-referrer policy;
- restrictive Permissions Policy;
- `X-Robots-Tag: noindex, nofollow, noarchive`.

The JavaScript deliberately avoids `innerHTML`, third-party resources, third-party network calls, or raw file uploads.

## Accessibility and responsive behavior

The interface includes:

- semantic sections, form fieldsets, labels, and ordered process/release rails;
- skip navigation;
- visible focus states;
- keyboard-operable navigation and controls;
- `aria-live` status for manifest readiness and notifications;
- reduced-motion support;
- responsive layouts down to 320px;
- high-contrast text and status treatment.

## Visual identity boundary

No official TMG logo or independent TMG brand authority exists in this repository today. The UI therefore uses a text-based `TMG / Video Intelligence` product treatment and a CSS-only geometric interface glyph.

This treatment is **not** registered as an official brand mark and must not supersede any later brand-authority decision.

## Validation

`pnpm ui:check` enforces:

- G0/current governed value proposition;
- absence of prohibited public claims;
- no inline script/style execution;
- no third-party URLs in UI assets;
- no `innerHTML` injection sink;
- only the governed bootstrap fetch;
- draft-manifest authority boundaries;
- CSP/noindex headers;
- Workers Static Assets configuration;
- current compatibility date;
- production release authority still unactivated.

`pnpm check` now includes this UI integrity gate in addition to existing type generation, TypeScript, tests, fixture validation, and commercialization/governance policy checks.
