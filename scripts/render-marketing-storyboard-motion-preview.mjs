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
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").slice(0, 4000)}`);
  }
  return result.stdout;
}

function previewDimensions(aspectRatio) {
  if (aspectRatio === "9:16") return { width: 720, height: 1280 };
  if (aspectRatio === "1:1") return { width: 720, height: 720 };
  return { width: 1280, height: 720 };
}

run("ffmpeg", ["-version"]);
run("ffprobe", ["-version"]);

const review = readJson("storyboard-review-package.json");
const brief = readJson("storyboard-creative-brief.json");
assert(Array.isArray(review.frames) && review.frames.length === 3, "expected exactly three storyboard frames");
assert(Array.isArray(brief.variants) && brief.variants.length === 3, "expected exactly three creative variants");

const previews = [];
for (let index = 0; index < review.frames.length; index += 1) {
  const frame = review.frames[index];
  const variant = brief.variants.find((candidate) => candidate.variantId === frame.variantId);
  assert(variant, `missing creative variant for storyboard frame ${frame.variantId}`);
  const source = `storyboard-frame-${index + 1}.bin`;
  const output = `storyboard-preview-${index + 1}.mp4`;
  const duration = Math.max(3, Math.min(8, Number(variant.targetProfile.durationSeconds) || 6));
  const { width, height } = previewDimensions(variant.targetProfile.aspectRatio);
  const fadeOutStart = Math.max(0, duration - 0.4).toFixed(2);
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    "fade=t=in:st=0:d=0.4",
    `fade=t=out:st=${fadeOutStart}:d=0.4`,
    "format=yuv420p",
  ].join(",");

  run("ffmpeg", [
    "-y",
    "-loop", "1",
    "-framerate", "30",
    "-i", source,
    "-vf", filter,
    "-t", String(duration),
    "-r", "30",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-movflags", "+faststart",
    output,
  ]);

  const bytes = fs.readFileSync(output);
  assert(bytes.length > 1024, `preview ${index + 1} is unexpectedly small`);
  assert(bytes.subarray(4, 8).toString("ascii") === "ftyp", `preview ${index + 1} is missing MP4 ftyp signature`);

  const probe = JSON.parse(run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration",
    "-of", "json",
    output,
  ]));
  const stream = probe.streams?.[0];
  assert(stream?.codec_name === "h264", `preview ${index + 1} is not H.264`);
  assert(Number(stream.width) === width && Number(stream.height) === height, `preview ${index + 1} dimensions mismatch`);
  const measuredDuration = Number(probe.format?.duration);
  assert(Number.isFinite(measuredDuration) && measuredDuration >= duration - 0.2, `preview ${index + 1} duration mismatch`);

  previews.push({
    schemaVersion: "tmg.marketing-storyboard-motion-preview.v1",
    variantId: frame.variantId,
    targetProfileId: frame.targetProfileId,
    sourceStoryboardSha256: frame.sha256,
    fileName: output,
    contentType: "video/mp4",
    bytes: bytes.length,
    sha256: sha256(bytes),
    codec: "h264",
    width,
    height,
    durationSeconds: measuredDuration,
    renderer: "deterministic_ffmpeg_ci",
    renderPhase: "review_mockup",
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  });
}

const evidence = {
  schemaVersion: "tmg.marketing-storyboard-motion-preview-evidence.v1",
  requestId: review.requestId,
  sourceRenderer: review.renderer,
  previews,
  statement: "These MP4s are deterministic review mockups compiled from Workers AI storyboard frames; they are not P-Video model outputs.",
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync(
  "storyboard-motion-preview-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
