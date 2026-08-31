import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(fs.readFileSync("storyboard-v11-manifest.json", "utf8"));
const renderPlan = JSON.parse(fs.readFileSync("storyboard-v11-video-render-plan.json", "utf8"));
if (manifest.schemaVersion !== "tmg.storyboard-manifest.v1.1") throw new Error("unexpected StoryboardManifest version");
if (renderPlan.schemaVersion !== "tmg.video-render-plan.v1") throw new Error("unexpected VideoRenderPlan version");

const sha = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
if (!fs.existsSync(font)) throw new Error("deterministic preview font is unavailable");

function escapeDrawtext(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ")
    .slice(0, 180);
}

const evidence = {
  schemaVersion: "tmg.storyboard-motion-preview-evidence.v1.1",
  requestId: manifest.requestId,
  tenantId: manifest.tenantId,
  previews: [],
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};

for (let targetIndex = 0; targetIndex < manifest.targets.length; targetIndex += 1) {
  const target = manifest.targets[targetIndex];
  if (target.shots.length !== 3) throw new Error(`target ${target.targetProfileId} must contain exactly three v1.1 shots`);
  const width = target.aspectRatio === "9:16" ? 720 : 1280;
  const height = target.aspectRatio === "9:16" ? 1280 : 720;
  const firstInput = `storyboard-v11-composed-${targetIndex + 1}-1.webp`;
  const middleInput = `storyboard-v11-composed-${targetIndex + 1}-2.webp`;
  const lastInput = `storyboard-v11-composed-${targetIndex + 1}-3.webp`;
  for (const path of [firstInput, middleInput, lastInput]) if (!fs.existsSync(path)) throw new Error(`missing local composed frame ${path}`);

  const titleCard = `storyboard-v11-title-${targetIndex + 1}.png`;
  const endCard = `storyboard-v11-end-${targetIndex + 1}.png`;
  const output = `storyboard-v11-preview-${targetIndex + 1}.mp4`;
  const title = escapeDrawtext(target.titleCard.headline);
  const endHeadline = escapeDrawtext(target.endCard.headline);
  const cta = escapeDrawtext(target.endCard.callToAction ?? "Learn more");

  const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", firstInput,
    "-vf", `${scale},drawbox=x=0:y=0:w=iw:h=ih:color=black@0.32:t=fill,drawtext=fontfile=${font}:text='${title}':fontcolor=white:fontsize=${Math.round(height * 0.055)}:x=(w-text_w)/2:y=(h-text_h)/2`,
    "-frames:v", "1", titleCard,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", lastInput,
    "-vf", `${scale},drawbox=x=0:y=0:w=iw:h=ih:color=black@0.38:t=fill,drawtext=fontfile=${font}:text='${endHeadline}':fontcolor=white:fontsize=${Math.round(height * 0.045)}:x=(w-text_w)/2:y=h*0.42-text_h,drawtext=fontfile=${font}:text='${cta}':fontcolor=white:fontsize=${Math.round(height * 0.035)}:x=(w-text_w)/2:y=h*0.58`,
    "-frames:v", "1", endCard,
  ]);

  const shots = target.shots;
  const filter = [
    `[0:v]${scale},format=yuv420p,trim=duration=${shots[0].durationSeconds},setpts=PTS-STARTPTS[v0]`,
    `[1:v]${scale},format=yuv420p,trim=duration=${shots[1].durationSeconds},setpts=PTS-STARTPTS[v1]`,
    `[2:v]${scale},format=yuv420p,trim=duration=${shots[2].durationSeconds},setpts=PTS-STARTPTS[v2]`,
    `[v0][v1][v2]concat=n=3:v=1:a=0[outv]`,
  ].join(";");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-loop", "1", "-i", titleCard,
    "-loop", "1", "-i", middleInput,
    "-loop", "1", "-i", endCard,
    "-filter_complex", filter,
    "-map", "[outv]", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ]);

  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", output,
  ], { encoding: "utf8" }));
  const stream = probe.streams?.[0];
  const duration = Number(probe.format?.duration);
  if (stream?.codec_name !== "h264" || stream.width !== width || stream.height !== height) throw new Error(`invalid motion preview stream for ${target.targetProfileId}`);
  if (Math.abs(duration - target.durationSeconds) > 0.25) throw new Error(`motion preview duration mismatch for ${target.targetProfileId}: ${duration}`);

  evidence.previews.push({
    targetProfileId: target.targetProfileId,
    titleCard: { path: titleCard, sha256: sha(titleCard) },
    endCard: { path: endCard, sha256: sha(endCard) },
    output: { path: output, sha256: sha(output), codec: "h264", width, height, durationSeconds: duration },
    shotDurations: shots.map((shot) => shot.durationSeconds),
    reviewOnly: true,
  });
}

fs.writeFileSync("storyboard-v11-motion-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
