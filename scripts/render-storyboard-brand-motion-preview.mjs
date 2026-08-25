import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").slice(0, 5000)}`);
  }
  return result.stdout;
}

function previewDimensions(aspectRatio) {
  if (aspectRatio === "9:16") return { width: 720, height: 1280 };
  if (aspectRatio === "1:1") return { width: 720, height: 720 };
  return { width: 1280, height: 720 };
}

function writeText(path, value) {
  const clean = String(value || "").replace(/[\r\n]+/g, " ").trim();
  fs.writeFileSync(path, clean || " ");
}

function renderSegment({ input, output, duration, width, height, textFiles = [] }) {
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
  ];
  for (const item of textFiles) {
    const fontSize = item.kind === "headline" ? Math.max(28, Math.round(width * 0.045)) : Math.max(22, Math.round(width * 0.028));
    const y = item.kind === "headline" ? "h*0.68" : "h*0.80";
    filters.push(
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${item.path}:fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.50:boxborderw=${Math.max(10, Math.round(width * 0.012))}:fix_bounds=1`,
    );
  }
  filters.push("format=yuv420p");
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1",
    "-framerate", "30",
    "-i", input,
    "-vf", filters.join(","),
    "-t", duration.toFixed(3),
    "-r", "30",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    output,
  ]);
}

run("ffmpeg", ["-version"]);
run("ffprobe", ["-version"]);
assert(fs.existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), "DejaVu Sans Bold is required for deterministic title/end copy rendering");

const manifest = readJson("storyboard-brand-manifest.json");
const renderPlan = readJson("storyboard-brand-video-render-plan.json");
assert(manifest.schemaVersion === "tmg.storyboard-manifest.v1.1", "unexpected StoryboardManifest schema");
assert(renderPlan.schemaVersion === "tmg.video-render-plan.v1", "unexpected VideoRenderPlan schema");
assert(Array.isArray(manifest.targets) && manifest.targets.length === 3, "expected exactly three storyboard targets");

const previews = [];
for (let targetIndex = 0; targetIndex < manifest.targets.length; targetIndex += 1) {
  const target = manifest.targets[targetIndex];
  const planTarget = renderPlan.targets.find((candidate) => candidate.variantId === target.variantId);
  assert(planTarget, `missing VideoRenderPlan target ${target.variantId}`);
  const { width, height } = previewDimensions(target.targetProfile.aspectRatio);
  const totalDuration = Number(target.targetProfile.durationSeconds);
  assert(Number.isFinite(totalDuration) && totalDuration >= 3, `invalid target duration ${target.variantId}`);
  const cardDuration = 0.5;
  const shotBudget = totalDuration - cardDuration * 2;
  const plannedShotTotal = target.shots.reduce((sum, shot) => sum + Number(shot.durationSeconds), 0);
  assert(plannedShotTotal > 0 && shotBudget > 0, `invalid shot timing ${target.variantId}`);
  const shotScale = shotBudget / plannedShotTotal;
  const segmentFiles = [];

  const titleHeadline = `storyboard-brand-title-${targetIndex + 1}-headline.txt`;
  const titleSupport = `storyboard-brand-title-${targetIndex + 1}-support.txt`;
  writeText(titleHeadline, target.titleCard.verifiedCopy.headline);
  writeText(titleSupport, target.titleCard.verifiedCopy.supportingText || "");
  const titleSegment = `storyboard-brand-segment-${targetIndex + 1}-00-title.mp4`;
  renderSegment({
    input: `storyboard-brand-title-${targetIndex + 1}.webp`,
    output: titleSegment,
    duration: cardDuration,
    width,
    height,
    textFiles: [
      { kind: "headline", path: titleHeadline },
      { kind: "support", path: titleSupport },
    ],
  });
  segmentFiles.push(titleSegment);

  for (let shotIndex = 0; shotIndex < target.shots.length; shotIndex += 1) {
    const shot = target.shots[shotIndex];
    const duration = Number(shot.durationSeconds) * shotScale;
    const segment = `storyboard-brand-segment-${targetIndex + 1}-${String(shotIndex + 1).padStart(2, "0")}.mp4`;
    renderSegment({
      input: `storyboard-brand-composed-${targetIndex + 1}-${shotIndex + 1}.webp`,
      output: segment,
      duration,
      width,
      height,
    });
    segmentFiles.push(segment);
  }

  const endHeadline = `storyboard-brand-end-${targetIndex + 1}-headline.txt`;
  const endSupport = `storyboard-brand-end-${targetIndex + 1}-support.txt`;
  writeText(endHeadline, target.endCard.verifiedCopy.callToAction || target.endCard.verifiedCopy.headline);
  writeText(endSupport, target.endCard.verifiedCopy.supportingText || "");
  const endSegment = `storyboard-brand-segment-${targetIndex + 1}-99-end.mp4`;
  renderSegment({
    input: `storyboard-brand-end-${targetIndex + 1}.webp`,
    output: endSegment,
    duration: cardDuration,
    width,
    height,
    textFiles: [
      { kind: "headline", path: endHeadline },
      { kind: "support", path: endSupport },
    ],
  });
  segmentFiles.push(endSegment);

  const concatFile = `storyboard-brand-concat-${targetIndex + 1}.txt`;
  fs.writeFileSync(concatFile, segmentFiles.map((file) => `file '${file}'`).join("\n") + "\n");
  const output = `storyboard-brand-preview-${targetIndex + 1}.mp4`;
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-c", "copy",
    "-movflags", "+faststart",
    output,
  ]);

  const bytes = fs.readFileSync(output);
  assert(bytes.length > 1024, `motion preview ${targetIndex + 1} is unexpectedly small`);
  assert(bytes.subarray(4, 8).toString("ascii") === "ftyp", `motion preview ${targetIndex + 1} is missing MP4 signature`);
  const probe = JSON.parse(run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration",
    "-of", "json",
    output,
  ]));
  const stream = probe.streams?.[0];
  const measuredDuration = Number(probe.format?.duration);
  assert(stream?.codec_name === "h264", `motion preview ${targetIndex + 1} is not H.264`);
  assert(Number(stream.width) === width && Number(stream.height) === height, `motion preview ${targetIndex + 1} dimensions mismatch`);
  assert(Number.isFinite(measuredDuration) && Math.abs(measuredDuration - totalDuration) <= 0.35, `motion preview ${targetIndex + 1} duration mismatch: ${measuredDuration} vs ${totalDuration}`);

  previews.push({
    schemaVersion: "tmg.storyboard-brand-motion-preview.v1.1",
    variantId: target.variantId,
    targetProfileId: target.targetProfile.profileId,
    storyboardManifestKey: renderPlan.storyboardManifestKey,
    composedFrameSha256s: target.shots.map((shot) => shot.composedFrame.sha256),
    titleCardSha256: target.titleCard.sha256,
    endCardSha256: target.endCard.sha256,
    fileName: output,
    contentType: "video/mp4",
    bytes: bytes.length,
    sha256: sha256(bytes),
    codec: "h264",
    width,
    height,
    durationSeconds: measuredDuration,
    renderer: "deterministic_ffmpeg_ci",
    renderPhase: "multi_shot_review_mockup",
    verifiedTitleCopyRendered: true,
    verifiedEndCopyRendered: true,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  });
}

const evidence = {
  schemaVersion: "tmg.storyboard-brand-motion-preview-evidence.v1.1",
  requestId: manifest.requestId,
  tenantId: manifest.tenantId,
  sourceStoryboardSchema: manifest.schemaVersion,
  videoRenderPlanProvider: renderPlan.provider,
  previews,
  statement: "These MP4s are deterministic multi-shot review mockups compiled from rights-gated composed storyboard frames; they are not P-Video outputs and confer no publication authority.",
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync("storyboard-brand-motion-preview-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
