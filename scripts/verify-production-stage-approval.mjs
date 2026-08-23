import fs from "node:fs";

const fail = (message) => {
  console.error(`production stage approval rejected: ${message}`);
  process.exit(2);
};
const required = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
};

const outDir = process.env.TMG_RELEASE_OUT ?? "production-release-control";
const manifestPath = `${outDir}/release-manifest.json`;
if (!fs.existsSync(manifestPath)) fail("release manifest is missing");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

let approval;
try {
  approval = JSON.parse(required("TMG_RELEASE_APPROVAL_JSON"));
} catch {
  fail("approval body must contain valid JSON");
}

const actor = required("GITHUB_ACTOR");
const commentId = required("TMG_RELEASE_APPROVAL_COMMENT_ID");
const commentCreatedAt = required("TMG_RELEASE_APPROVAL_CREATED_AT");
const consumed = new Set((process.env.TMG_RELEASE_CONSUMED_APPROVAL_IDS ?? "").split("\n").map((value) => value.trim()).filter(Boolean));

if (approval.schemaVersion !== "1.0.0") fail("schemaVersion must be 1.0.0");
if (!/^[A-Za-z0-9._:-]{12,128}$/.test(approval.approvalId ?? "")) fail("approvalId is invalid");
if (approval.humanAuthor !== actor) fail("approval humanAuthor must equal the GitHub comment author");
if (actor.endsWith("[bot]") || actor === "github-actions") fail("automation-authored approval is forbidden");
if (approval.automationAuthored !== false) fail("automationAuthored must be false");
if (approval.protectedMainSha !== manifest.candidateMainSha) fail("protectedMainSha does not match manifest");
if (approval.workerVersionId !== manifest.candidateWorkerVersionId) fail("workerVersionId does not match manifest");
const manifestSha = fs.readFileSync(`${outDir}/release-manifest.sha256`, "utf8").trim().split(/\s+/)[0];
if (approval.releaseManifestSha256 !== manifestSha) fail("releaseManifestSha256 does not match manifest");
if (approval.capabilityId !== manifest.capabilityId) fail("capabilityId does not match manifest");
if (approval.stageId !== "S1" || manifest.maxStage !== "S1") fail("only S1 is eligible in v1");
if (approval.tenantCohortId !== manifest.tenantCohortId) fail("tenant cohort does not match manifest");
if (approval.noOtherCapabilityAuthorized !== true) fail("approval must explicitly authorize no other capability");
if (consumed.has(approval.approvalId)) fail("approvalId has already been consumed");

const issuedAt = Date.parse(approval.issuedAt ?? "");
const notAfter = Date.parse(approval.notAfter ?? "");
const commentAt = Date.parse(commentCreatedAt);
const now = Date.now();
if (![issuedAt, notAfter, commentAt].every(Number.isFinite)) fail("approval timestamps must be valid ISO date-times");
if (notAfter <= issuedAt) fail("notAfter must be after issuedAt");
if (notAfter - issuedAt > 30 * 60 * 1000) fail("approval validity window must not exceed 30 minutes");
if (commentAt < issuedAt - 60_000 || commentAt > notAfter) fail("approval comment timestamp is outside approval validity window");
if (now > notAfter) fail("approval has expired");
if (issuedAt > now + 60_000) fail("approval issuedAt is in the future");

fs.writeFileSync(`${outDir}/validated-stage-approval.json`, `${JSON.stringify({
  schemaVersion: "1.0.0",
  approvalId: approval.approvalId,
  approvalCommentId: commentId,
  humanAuthor: actor,
  protectedMainSha: approval.protectedMainSha,
  workerVersionId: approval.workerVersionId,
  releaseManifestSha256: approval.releaseManifestSha256,
  capabilityId: approval.capabilityId,
  stageId: "S1",
  tenantCohortId: approval.tenantCohortId,
  issuedAt: approval.issuedAt,
  notAfter: approval.notAfter,
  noOtherCapabilityAuthorized: true,
  automationAuthority: false,
}, null, 2)}\n`, { flag: "wx" });
console.log(`validated one-time S1 approval ${approval.approvalId}`);
