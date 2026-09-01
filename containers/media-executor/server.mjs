import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_STDIO_BYTES = 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validObjectKey(key, prefix) {
  return typeof key === "string" && key.startsWith(prefix) && key.length <= 900 && !key.includes("..") && !key.includes("\\") && !/[\u0000-\u001f\u007f]/.test(key);
}

function run(command, args, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STDIO_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_STDIO_BYTES - stdout.length);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDIO_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STDIO_BYTES - stderr.length);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      resolve({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}

async function toolVersion(binary) {
  const result = await run(binary, ["-version"], 10_000);
  return result.stdout.split(/\r?\n/)[0]?.trim() || `${binary} unavailable`;
}

async function downloadInput(key, destination) {
  if (!validObjectKey(key, "quarantine/")) throw new Error("invalid_input_object_key");
  const response = await fetch(`http://work-requests.r2/object/${encodeURIComponent(key)}`);
  if (!response.ok) throw new Error(`input_download_failed:${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return bytes.byteLength;
}

async function uploadDerivative(key, sourcePath, contentType) {
  if (!validObjectKey(key, "derived/")) throw new Error("invalid_derivative_object_key");
  const bytes = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await fetch(`http://derivatives.r2/object/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "x-tmg-sha256": sha256,
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`derivative_upload_failed:${response.status}:${await response.text()}`);
  return { key, size: bytes.byteLength, sha256, contentType };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const format = probe?.format && typeof probe.format === "object" ? probe.format : {};
  return {
    format: {
      name: typeof format.format_name === "string" ? format.format_name : null,
      longName: typeof format.format_long_name === "string" ? format.format_long_name : null,
      durationSeconds: numberOrNull(format.duration),
      sizeBytes: numberOrNull(format.size),
      bitRate: numberOrNull(format.bit_rate),
      startTimeSeconds: numberOrNull(format.start_time),
    },
    streams: streams.map((stream) => ({
      index: Number.isInteger(stream.index) ? stream.index : null,
      type: typeof stream.codec_type === "string" ? stream.codec_type : null,
      codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
      codecLongName: typeof stream.codec_long_name === "string" ? stream.codec_long_name : null,
      profile: typeof stream.profile === "string" ? stream.profile : null,
      width: numberOrNull(stream.width),
      height: numberOrNull(stream.height),
      pixelFormat: typeof stream.pix_fmt === "string" ? stream.pix_fmt : null,
      frameRate: typeof stream.avg_frame_rate === "string" ? stream.avg_frame_rate : null,
      durationSeconds: numberOrNull(stream.duration),
      bitRate: numberOrNull(stream.bit_rate),
      sampleRate: numberOrNull(stream.sample_rate),
      channels: numberOrNull(stream.channels),
      channelLayout: typeof stream.channel_layout === "string" ? stream.channel_layout : null,
    })),
  };
}

async function inspect(inputPath, inputBytes) {
  const probeRun = await run("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-print_format", "json",
    inputPath,
  ]);
  let probe = {};
  if (probeRun.code === 0) {
    try { probe = JSON.parse(probeRun.stdout); } catch { probe = {}; }
  }

  const decodeRun = await run("ffmpeg", [
    "-nostdin",
    "-v", "error",
    "-xerror",
    "-i", inputPath,
    "-map", "0",
    "-f", "null",
    "-",
  ]);

  const normalized = normalizeProbe(probe);
  const corruptionSignals = decodeRun.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);

  return {
    schema: "tmg.technical-inspection.v1",
    inspectedBytes: inputBytes,
    probeSucceeded: probeRun.code === 0,
    decodeSucceeded: decodeRun.code === 0,
    decodeExitCode: decodeRun.code,
    decodeSignal: decodeRun.signal,
    corruptionSignals,
    ...normalized,
    toolchain: {
      ffprobe: await toolVersion("ffprobe"),
      ffmpeg: await toolVersion("ffmpeg"),
    },
  };
}

function videoDurationSeconds(inspection) {
  const duration = Number(inspection?.format?.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const streamDuration = (inspection?.streams || []).map((stream) => Number(stream.durationSeconds)).find((value) => Number.isFinite(value) && value > 0);
  return streamDuration || 1;
}

async function makePoster(inputPath, outputPath, atSeconds) {
  const result = await run("ffmpeg", [
    "-nostdin", "-y", "-v", "error",
    "-ss", String(Math.max(0, atSeconds)),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=w='min(1280,iw)':h=-2",
    "-q:v", "2",
    outputPath,
  ]);
  if (result.code !== 0) throw new Error(`poster_generation_failed:${result.stderr.slice(0, 400)}`);
}

async function makeFrame(inputPath, outputPath, atSeconds) {
  const result = await run("ffmpeg", [
    "-nostdin", "-y", "-v", "error",
    "-ss", String(Math.max(0, atSeconds)),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=w='min(1280,iw)':h=-2",
    "-q:v", "3",
    outputPath,
  ]);
  if (result.code !== 0) throw new Error(`frame_extraction_failed:${result.stderr.slice(0, 400)}`);
}

async function makeWebMp4(inputPath, outputPath) {
  const result = await run("ffmpeg", [
    "-nostdin", "-y", "-v", "error",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "22",
    "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,format=yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ], 180_000);
  if (result.code !== 0) throw new Error(`transcode_failed:${result.stderr.slice(0, 500)}`);
}

async function executeRecipe(inputPath, inspection, recipeId, outputPrefix, root) {
  const outputs = [];
  const duration = videoDurationSeconds(inspection);
  const posterTime = Math.min(Math.max(duration * 0.25, 0.05), Math.max(duration - 0.05, 0.05));

  if (["poster-jpeg-v1", "preview-pack-v1"].includes(recipeId)) {
    const path = join(root, "poster.jpg");
    await makePoster(inputPath, path, posterTime);
    outputs.push(await uploadDerivative(`${outputPrefix}/poster.jpg`, path, "image/jpeg"));
  }

  if (["frame-set-3-v1", "preview-pack-v1"].includes(recipeId)) {
    const fractions = [0.15, 0.5, 0.85];
    for (let index = 0; index < fractions.length; index += 1) {
      const path = join(root, `frame-${index + 1}.jpg`);
      const time = Math.min(Math.max(duration * fractions[index], 0), Math.max(duration - 0.02, 0));
      await makeFrame(inputPath, path, time);
      outputs.push(await uploadDerivative(`${outputPrefix}/frame-${index + 1}.jpg`, path, "image/jpeg"));
    }
  }

  if (["web-mp4-720p-v1", "preview-pack-v1"].includes(recipeId)) {
    const path = join(root, "web-720p.mp4");
    await makeWebMp4(inputPath, path);
    outputs.push(await uploadDerivative(`${outputPrefix}/web-720p.mp4`, path, "video/mp4"));
  }

  if (!outputs.length) throw new Error("unsupported_derivative_recipe");
  return outputs;
}

async function handleTechnical(body) {
  const { inputKey, fileId, name, mime } = body || {};
  if (typeof fileId !== "string" || typeof name !== "string" || typeof mime !== "string") throw new Error("invalid_technical_inspection_request");
  const root = await mkdtemp(join(tmpdir(), "tmg-inspect-"));
  try {
    const inputPath = join(root, `input-${randomUUID()}`);
    const inputBytes = await downloadInput(inputKey, inputPath);
    const result = await inspect(inputPath, inputBytes);
    return { ...result, fileId, name, claimedMime: mime };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function handleDerivative(body) {
  const { inputKey, fileId, recipeId, outputPrefix } = body || {};
  if (typeof fileId !== "string" || typeof recipeId !== "string" || !validObjectKey(outputPrefix, "derived/")) throw new Error("invalid_derivative_request");
  const root = await mkdtemp(join(tmpdir(), "tmg-derive-"));
  try {
    const inputPath = join(root, `input-${randomUUID()}`);
    const inputBytes = await downloadInput(inputKey, inputPath);
    const inspection = await inspect(inputPath, inputBytes);
    if (!inspection.probeSucceeded || !inspection.decodeSucceeded) throw new Error("derivative_source_failed_technical_validation");
    const outputs = await executeRecipe(inputPath, inspection, recipeId, outputPrefix, root);
    return {
      schema: "tmg.derivative-execution.v1",
      fileId,
      recipeId,
      outputPrefix,
      sourceInspection: inspection,
      outputs,
      toolchain: inspection.toolchain,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { status: "ok", service: "tmg-media-executor", ffmpeg: await toolVersion("ffmpeg"), ffprobe: await toolVersion("ffprobe") });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    const body = await readJson(req);
    if (req.url === "/technical-inspection") return json(res, 200, await handleTechnical(body));
    if (req.url === "/derivative") return json(res, 200, await handleDerivative(body));
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`TMG media executor listening on :${port}`);
});
