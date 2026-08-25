import crypto from "node:crypto";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("storyboard-v11-manifest.json", "utf8"));
const renderPlan = JSON.parse(fs.readFileSync("storyboard-v11-video-render-plan.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync("storyboard-v11-fixture.json", "utf8"));

const sha = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");

if (manifest.schemaVersion !== "tmg.storyboard-manifest.v1.1") throw new Error("StoryboardManifest v1.1 missing");
if (manifest.tenantId !== fixture.tenantId || manifest.requestId !== fixture.requestId) throw new Error("StoryboardManifest identity mismatch");
if (manifest.rights.evidenceRef !== "rights://storyboard-v11/synthetic-brand-package") throw new Error("StoryboardManifest rights evidence mismatch");
if (manifest.rights.imageReuseAuthorized !== true || manifest.rights.exactLogoOverlayAuthorized !== true) throw new Error("StoryboardManifest rights authority missing");
if (manifest.governance.humanReviewRequired !== true || manifest.governance.publicationAuthority !== false || manifest.governance.externalDistributionAuthority !== false) throw new Error("StoryboardManifest governance mismatch");
if (manifest.targets.length !== 3) throw new Error(`expected three target manifests, got ${manifest.targets.length}`);

let composedCount = 0;
for (let ti = 0; ti < manifest.targets.length; ti += 1) {
  const target = manifest.targets[ti];
  if (target.shots.length !== 3) throw new Error(`target ${target.targetProfileId} is not multi-shot`);
  if (target.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) !== target.durationSeconds) throw new Error(`target ${target.targetProfileId} shot durations do not match target duration`);
  if (!target.titleCard || target.titleCard.kind !== "title") throw new Error(`target ${target.targetProfileId} title card missing`);
  if (!target.endCard || target.endCard.kind !== "end") throw new Error(`target ${target.targetProfileId} end card missing`);
  for (let si = 0; si < target.shots.length; si += 1) {
    const shot = target.shots[si];
    const path = `storyboard-v11-composed-${ti + 1}-${si + 1}.webp`;
    if (!fs.existsSync(path)) throw new Error(`missing composed frame ${path}`);
    if (sha(path) !== shot.evidence.composedFrame.sha256) throw new Error(`composed frame SHA mismatch ${path}`);
    const bytes = fs.readFileSync(path);
    if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error(`composed frame is not WebP ${path}`);
    if (shot.evidence.composedFrame.exactApprovedLogoOverlayApplied !== true) throw new Error(`exact logo evidence missing for ${shot.shotId}`);
    if (shot.evidence.composedFrame.approvedLogoSha256 !== fixture.logoSha256) throw new Error(`approved logo SHA mismatch for ${shot.shotId}`);
    if (!shot.approvedAssets.some((asset) => asset.usage === "exact_logo_overlay" && asset.sha256 === fixture.logoSha256)) throw new Error(`shot ${shot.shotId} lacks exact approved logo reference`);
    composedCount += 1;
  }
}
if (composedCount !== 9) throw new Error(`expected nine composed frames, got ${composedCount}`);

if (renderPlan.schemaVersion !== "tmg.video-render-plan.v1") throw new Error("VideoRenderPlan v1 missing");
if (renderPlan.renderer.preferredProvider !== "pruna/p-video") throw new Error("VideoRenderPlan provider mismatch");
if (renderPlan.renderer.executionState !== "disabled_pending_provider_capacity") throw new Error("VideoRenderPlan must remain disabled pending provider capacity");
if (renderPlan.governance.paidProviderExecutionAuthorized !== false || renderPlan.governance.publicationAuthority !== false) throw new Error("VideoRenderPlan authority boundary violated");
if (renderPlan.targets.length !== 3 || renderPlan.targets.some((target) => target.shots.length !== 3)) throw new Error("VideoRenderPlan does not preserve multi-shot targets");

const evidence = {
  schemaVersion: "tmg.storyboard-brand-composition-acceptance.v1.1",
  requestId: manifest.requestId,
  tenantId: manifest.tenantId,
  targetCount: manifest.targets.length,
  shotCount: composedCount,
  exactApprovedLogoSha256: fixture.logoSha256,
  storyboardManifestSha256: sha("storyboard-v11-manifest.json"),
  videoRenderPlanSha256: sha("storyboard-v11-video-render-plan.json"),
  renderer: manifest.provenance.generatedImageModel,
  compositionProvider: manifest.provenance.exactCompositionProvider,
  paidProviderExecutionAuthorized: false,
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync("storyboard-v11-acceptance-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
