import crypto from "node:crypto";
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const review = readJson("marketing-review-package.json");
const context = readJson("marketing-campaign-context.json");
const creative = readJson("marketing-creative-brief.json");
const request = readJson("marketing-acceptance-request.json");

const failures = [];
const fail = (message) => failures.push(message);

if (review.schemaVersion !== "tmg.marketing-review-package.v1") fail("review package schema mismatch");
if (review.requestId !== request.requestId) fail("review package request mismatch");
if (review.humanReviewRequired !== true) fail("review package must require human review");
if (review.publicationAuthority !== false) fail("review package must not grant publication authority");
if (review.externalDistributionAuthority !== false) fail("review package must not grant external distribution authority");
if (!Array.isArray(review.videos) || review.videos.length !== 3) fail("review package must contain exactly three canary videos");

if (context.schemaVersion !== "tmg.campaign-context.v1") fail("campaign context schema mismatch");
if (context.provenance?.provider !== "firecrawl_v2") fail("campaign context must bind Firecrawl v2 provenance");
if (!(context.provenance?.pageCount > 0)) fail("campaign context must include crawled pages");
if (context.governance?.publicationAuthority !== false) fail("campaign context must deny publication authority");
if (context.governance?.discoveredAssetReuseRequiresRightsEvidence !== true) {
  fail("campaign context must retain discovered-asset rights gate");
}

if (creative.schemaVersion !== "tmg.marketing-creative-brief.v1") fail("creative brief schema mismatch");
if (creative.humanReviewRequired !== true) fail("creative brief must require human review");
const expectedProfiles = ["tiktok.organic.v1", "youtube.short.v1", "web.hero.v1"].sort();
const actualProfiles = (creative.variants ?? []).map((variant) => variant.targetProfile?.profileId).sort();
if (JSON.stringify(actualProfiles) !== JSON.stringify(expectedProfiles)) {
  fail(`creative target profiles mismatch: ${JSON.stringify(actualProfiles)}`);
}

const videoEvidence = [];
for (let index = 0; index < 3; index += 1) {
  const path = `/tmp/tmg-marketing-video-${index + 1}.mp4`;
  if (!fs.existsSync(path)) {
    fail(`missing downloaded video ${path}`);
    continue;
  }
  const bytes = fs.readFileSync(path);
  if (bytes.length < 16) {
    fail(`video ${path} is too small`);
    continue;
  }
  if (bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    fail(`video ${path} does not have an MP4 ftyp box`);
  }
  videoEvidence.push({
    index: index + 1,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}

if (failures.length > 0) {
  console.error("marketing-runtime-acceptance verification failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const evidence = {
  schemaVersion: "tmg.marketing-runtime-acceptance-evidence.v1",
  requestId: request.requestId,
  workflowInstanceId: request.workflowInstanceId,
  crawlProvider: context.provenance.provider,
  crawledPages: context.provenance.pageCount,
  targetProfiles: expectedProfiles,
  videos: videoEvidence,
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync(
  "marketing-runtime-acceptance-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
