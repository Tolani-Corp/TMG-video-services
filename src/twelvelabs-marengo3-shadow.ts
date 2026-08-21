import { z } from "zod";
import {
  validateEmbedding,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type SegmentEmbeddingInput,
} from "./embedding";

const DEFAULT_ENDPOINT = "https://api.twelvelabs.io/v1.3/embed-v2";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_SHADOW_CLIP_MS = 4_000;
const MAX_SHADOW_CLIP_MS = 30_000;

const embeddingItemSchema = z.object({
  embedding: z.array(z.number()),
  embedding_option: z.string(),
  embedding_scope: z.string(),
  start_sec: z.number().optional(),
  end_sec: z.number().optional(),
});

const syncEmbeddingResponseSchema = z.object({
  data: z.array(embeddingItemSchema),
});

export const TWELVELABS_MARENGO3_SHADOW_PROFILE: EmbeddingProfile = {
  id: "twelvelabs_marengo3_fused_512_v1",
  provider: "twelvelabs",
  model: "marengo3.0",
  modelVersion: "3.0",
  dimensions: 512,
  modalities: ["visual", "audio", "transcription", "fused"],
  compatibilityGroup: "marengo3_fused_512_v1",
};

export type TwelveLabsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TwelveLabsShadowAdapterOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetcher?: TwelveLabsFetch;
}

export class TwelveLabsShadowAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwelveLabsShadowAdapterError";
  }
}

function requireAuthorizedHttpsMediaRef(mediaRef: string): URL {
  let url: URL;
  try {
    url = new URL(mediaRef);
  } catch {
    throw new TwelveLabsShadowAdapterError(
      "Marengo shadow probes require an explicitly authorized HTTPS media URL.",
    );
  }

  if (url.protocol !== "https:") {
    throw new TwelveLabsShadowAdapterError(
      "Marengo shadow probes reject private or non-HTTPS media references until an approved egress bridge exists.",
    );
  }

  return url;
}

function requireShadowClipWindow(input: SegmentEmbeddingInput): void {
  const durationMs = input.endMs - input.startMs;
  if (input.startMs < 0 || durationMs < MIN_SHADOW_CLIP_MS || durationMs > MAX_SHADOW_CLIP_MS) {
    throw new TwelveLabsShadowAdapterError(
      `Marengo shadow probes require a governed clip window between ${MIN_SHADOW_CLIP_MS} and ${MAX_SHADOW_CLIP_MS} milliseconds.`,
    );
  }
}

export class TwelveLabsMarengo3ShadowProvider implements EmbeddingProvider {
  readonly profile = TWELVELABS_MARENGO3_SHADOW_PROFILE;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: TwelveLabsFetch;

  constructor(options: TwelveLabsShadowAdapterOptions) {
    if (!options.apiKey.trim()) {
      throw new TwelveLabsShadowAdapterError("A TwelveLabs API key is required for shadow probes.");
    }

    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  async embedSegment(input: SegmentEmbeddingInput): Promise<number[]> {
    requireShadowClipWindow(input);
    const mediaUrl = requireAuthorizedHttpsMediaRef(input.mediaRef);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          input_type: "video",
          model_name: "marengo3.0",
          video: {
            media_source: { url: mediaUrl.toString() },
            start_sec: input.startMs / 1000,
            end_sec: input.endMs / 1000,
            embedding_option: ["visual", "audio", "transcription"],
            embedding_scope: ["asset"],
            embedding_type: ["fused_embedding"],
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TwelveLabsShadowAdapterError(
          `TwelveLabs Embed API v2 returned HTTP ${response.status}.`,
        );
      }

      const parsed = syncEmbeddingResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new TwelveLabsShadowAdapterError(
          "TwelveLabs Embed API v2 returned an unexpected response shape.",
        );
      }

      const fused = parsed.data.data.filter(
        (item) => item.embedding_option === "fused" && item.embedding_scope === "asset",
      );
      if (fused.length !== 1) {
        throw new TwelveLabsShadowAdapterError(
          `Expected exactly one fused asset embedding from Marengo; received ${fused.length}.`,
        );
      }

      const vector = fused[0]?.embedding;
      if (!vector) {
        throw new TwelveLabsShadowAdapterError("Marengo response did not contain an embedding vector.");
      }
      validateEmbedding(this.profile, vector);
      return vector;
    } catch (error) {
      if (error instanceof TwelveLabsShadowAdapterError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TwelveLabsShadowAdapterError("TwelveLabs shadow request timed out.");
      }
      throw new TwelveLabsShadowAdapterError("TwelveLabs shadow request failed.");
    } finally {
      clearTimeout(timer);
    }
  }
}
