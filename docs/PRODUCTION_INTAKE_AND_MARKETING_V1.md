# TMG Production Intake & Marketing Service v1

## Purpose

TMG uses one checklist-driven request model for ordinary video production and marketing campaigns.

The customer experience is organized around six questions:

1. **What do you want?** — deliverables.
2. **What are we working with?** — uploaded media or an authorized website/app context source.
3. **What are we allowed to do?** — rights and usage evidence.
4. **Where will it be used?** — structured distribution targets.
5. **How should it look?** — brand assets and creative references.
6. **How should it arrive?** — delivery, review, packaging and API handoff preferences.

Required checklist rows are:

- Project brief
- Source media or product context
- Rights and usage evidence
- Distribution targets

Optional rows are:

- Brand assets
- Reference media
- Delivery preferences

## Distribution targets

TMG treats destination as production context rather than post-production metadata. A target contains:

- platform,
- surface,
- usage mode,
- optional versioned output-profile ID,
- optional notes.

Examples include YouTube Shorts, TikTok organic, TikTok paid ads, owned website hero video, web-app feed video, mobile-app promo, OTT/streaming, email/landing page, internal use and a neutral general-purpose master.

A single request may have multiple targets. The compiled production plan binds every requested deliverable to those targets so downstream skills can create platform-specific variants.

## Marketing campaign service

Marketing-specific deliverables are:

- `campaign_plan`
- `branded_marketing_videos`
- `social_copy`

A marketing campaign can use uploaded source media or a structured product-context reference.

Supported context-source classes include:

- website,
- web app,
- mobile app reference surface,
- product page,
- documentation site.

The context reference must use HTTPS and explicitly state requester crawl authorization. It also separately records whether the requester represents that discovered site assets may be reused. Public availability alone does not grant asset-reuse authority.

## Governed discovery

When a marketing request contains a website/app context source, TMG compiles an immutable `tmg.marketing-discovery-plan.v1`.

The initial provider contract targets Firecrawl v2. It is bounded by:

- explicit include/exclude paths,
- page limit,
- discovery-depth limit,
- optional subdomain permission,
- `allowExternalLinks=false`,
- `ignoreRobotsTxt=false`,
- no publication authority,
- no external-distribution authority.

The intended discovery output is a governed campaign-context manifest containing:

- brand context,
- product/service context,
- messaging context,
- candidate asset inventory,
- source/provenance references.

Candidate assets remain candidates until reuse rights are validated.

## Campaign production flow

```text
Customer request
      |
      v
Checklist
      |
      +-- brief
      +-- uploads or authorized site/app
      +-- rights evidence
      +-- distribution targets
      +-- optional brand/reference assets
      |
      v
Immutable ProductionPlan
      |
      +-- if site/app source --> MarketingDiscoveryPlan
      |
      v
Campaign context
      |
      v
Campaign strategy / creative concepts
      |
      v
Target-specific branded video production
      |
      v
ProductionPackage
      |
      v
Customer review / API handoff
```

## Authority boundary

TMG may prepare assets for a destination but does not automatically publish them.

TMG does not infer:

- site ownership from URL access,
- asset-reuse rights from public discoverability,
- paid-ad rights from organic-use rights,
- publication authority from production authority,
- authenticated application access from a public URL.

Publication and external distribution remain separate explicit authorities.

## Current implementation status

The request, checklist, R2 multipart upload, distribution-target, production-plan, marketing-discovery-plan and Workflow orchestration contracts are implemented behind the disabled development API gate.

The Firecrawl execution adapter, campaign-context compiler and media-production skill adapters remain follow-on work and must not be represented as active until their provider bindings and acceptance evidence are complete.
