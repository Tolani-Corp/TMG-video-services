import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const GENERATED_MEDIA_PATH =
  process.env.TMG_MARENGO_GENERATED_MEDIA_PATH ?? "/tmp/tmg-marengo-shadow-generated.mp4";
const CONTROL_OUT =
  process.env.TMG_MARENGO_RUNTIME_CONTROL_PATH ?? "/tmp/tmg-marengo-shadow-control-runtime.json";
const CONTROL_TEMPLATE = "fixtures/marengo-shadow/control.json";

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    const diagnostic = {
      command,
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stderr: (result.stderr ?? "").trim().slice(-4000),
      stdout: (result.stdout ?? "").trim().slice(-2000),
    };
    console.error(`subprocess failure: ${JSON.stringify(diagnostic)}`);
    throw new Error(`${command} failed with status ${String(result.status)}`);
  }

  if (!quiet && result.stderr?.trim()) {
    console.error(result.stderr.trim());
  }
  return result.stdout ?? "";
}

function main() {
  console.log(`ffmpeg-version=${run("ffmpeg", ["-hide_banner", "-version"], { quiet: true }).split("\n")[0]}`);

  const encoders = run("ffmpeg", ["-hide_banner", "-encoders"], { quiet: true });
  const hasLibx264 = /\blibx264\b/.test(encoders);
  const hasAac = /^\s*A.*\baac\b/m.test(encoders) || /\baac\b/.test(encoders);
  console.log(`ffmpeg-encoder-capabilities libx264=${hasLibx264} aac=${hasAac}`);
  if (!hasLibx264 || !hasAac) {
    throw new Error("GitHub runner FFmpeg does not expose the required libx264/AAC encoders.");
  }

  run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=360x360:r=25:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=5",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-g",
      "50",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      "-shortest",
      GENERATED_MEDIA_PATH,
    ],
    { quiet: true },
  );

  const probe = JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels",
        "-of",
        "json",
        GENERATED_MEDIA_PATH,
      ],
      { quiet: true },
    ),
  );

  const media = fs.readFileSync(GENERATED_MEDIA_PATH);
  const sha256 = crypto.createHash("sha256").update(media).digest("hex");
  const bytes = media.byteLength;
  const durationSeconds = Number(probe?.format?.duration ?? 0);
  const video = probe?.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe?.streams?.find((stream) => stream.codec_type === "audio");

  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) {
    throw new Error(`Generated Marengo fixture duration is invalid: ${durationSeconds}`);
  }
  if (video?.codec_name !== "h264" || video?.width !== 360 || video?.height !== 360) {
    throw new Error(
      `Generated Marengo fixture video contract mismatch: ${JSON.stringify({
        codec: video?.codec_name,
        width: video?.width,
        height: video?.height,
      })}`,
    );
  }
  if (video?.pix_fmt !== "yuv420p" || video?.r_frame_rate !== "25/1") {
    throw new Error(
      `Generated Marengo fixture pixel/fps mismatch: ${JSON.stringify({
        pixelFormat: video?.pix_fmt,
        fps: video?.r_frame_rate,
      })}`,
    );
  }
  if (audio?.codec_name !== "aac" || String(audio?.sample_rate) !== "48000") {
    throw new Error(
      `Generated Marengo fixture audio contract mismatch: ${JSON.stringify({
        codec: audio?.codec_name,
        sampleRate: audio?.sample_rate,
        channels: audio?.channels,
      })}`,
    );
  }

  const control = JSON.parse(fs.readFileSync(CONTROL_TEMPLATE, "utf8"));
  control.media.runtime = {
    sha256,
    bytes,
    durationMs: Math.round(durationSeconds * 1000),
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    fps: video.r_frame_rate,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: audio.channels,
    generatedAt: new Date().toISOString(),
  };
  control.media.objectKey =
    "tenants/tmg_fixture/assets/harmless_marengo_shadow_fixture_001/media/original.mp4";
  fs.writeFileSync(CONTROL_OUT, `${JSON.stringify(control, null, 2)}\n`);

  const envLines = [
    `TMG_MARENGO_FIXTURE_SHA256=${sha256}`,
    `TMG_MARENGO_FIXTURE_BYTES=${bytes}`,
    `TMG_MARENGO_FIXTURE_DURATION_SECONDS=${durationSeconds}`,
  ];
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `${envLines.join("\n")}\n`);
  }

  console.log(
    JSON.stringify({
      sha256,
      bytes,
      durationSeconds,
      video: {
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        pixelFormat: video.pix_fmt,
        fps: video.r_frame_rate,
      },
      audio: {
        codec: audio.codec_name,
        sampleRate: Number(audio.sample_rate),
        channels: audio.channels,
      },
      runtimeControl: CONTROL_OUT,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(
    `Marengo fixture generation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exit(1);
}
