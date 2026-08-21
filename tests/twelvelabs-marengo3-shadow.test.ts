import { describe, expect, it, vi } from "vitest";
import { EmbeddingProviderRouter } from "../src/provider-router";
import {
  TwelveLabsMarengo3ShadowProvider,
  TwelveLabsShadowAdapterError,
} from "../src/twelvelabs-marengo3-shadow";

function fusedResponse(dimensions = 512): Response {
  return Response.json({
    data: [
      {
        embedding: Array.from({ length: dimensions }, (_, index) => index / dimensions),
        embedding_option: "fused",
        embedding_scope: "asset",
        start_sec: 0,
        end_sec: 5,
      },
    ],
  });
}

const input = {
  assetId: "asset-1",
  segmentId: "segment-1",
  startMs: 0,
  endMs: 5_000,
  mediaRef: "https://media.example.com/authorized/video.mp4",
};

describe("TwelveLabsMarengo3ShadowProvider", () => {
  it("builds a Marengo 3.0 fused video request and validates 512 dimensions", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => fusedResponse());
    const provider = new TwelveLabsMarengo3ShadowProvider({
      apiKey: "shadow-test-key",
      fetcher,
    });

    const vector = await provider.embedSegment(input);

    expect(vector).toHaveLength(512);
    expect(provider.profile.compatibilityGroup).toBe("marengo3_fused_512_v1");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twelvelabs.io/v1.3/embed-v2");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)?.["x-api-key"]).toBe("shadow-test-key");

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      input_type: "video",
      model_name: "marengo3.0",
      video: {
        media_source: { url: input.mediaRef },
        start_sec: 0,
        end_sec: 5,
        embedding_option: ["visual", "audio", "transcription"],
        embedding_scope: ["asset"],
        embedding_type: ["fused_embedding"],
      },
    });
  });

  it("rejects private R2 references before any external request", async () => {
    const fetcher = vi.fn(async () => fusedResponse());
    const provider = new TwelveLabsMarengo3ShadowProvider({ apiKey: "test-key", fetcher });

    await expect(
      provider.embedSegment({ ...input, mediaRef: "r2://private-bucket/video.mp4" }),
    ).rejects.toThrow(/approved egress bridge/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects clip windows outside the governed 4-30 second shadow range", async () => {
    const fetcher = vi.fn(async () => fusedResponse());
    const provider = new TwelveLabsMarengo3ShadowProvider({ apiKey: "test-key", fetcher });

    await expect(provider.embedSegment({ ...input, endMs: 3_999 })).rejects.toThrow(/between 4000 and 30000/);
    await expect(provider.embedSegment({ ...input, endMs: 30_001 })).rejects.toThrow(/between 4000 and 30000/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on wrong-dimensional or malformed responses", async () => {
    const shortVectorProvider = new TwelveLabsMarengo3ShadowProvider({
      apiKey: "test-key",
      fetcher: async () => fusedResponse(511),
    });
    await expect(shortVectorProvider.embedSegment(input)).rejects.toThrow(
      TwelveLabsShadowAdapterError,
    );

    const malformedProvider = new TwelveLabsMarengo3ShadowProvider({
      apiKey: "test-key",
      fetcher: async () => Response.json({ unexpected: true }),
    });
    await expect(malformedProvider.embedSegment(input)).rejects.toThrow(/unexpected response shape/);
  });

  it("does not include API keys or provider response bodies in HTTP errors", async () => {
    const apiKey = "sensitive-shadow-key";
    const provider = new TwelveLabsMarengo3ShadowProvider({
      apiKey,
      fetcher: async () =>
        new Response(`upstream leaked ${apiKey}`, {
          status: 429,
          headers: { "content-type": "text/plain" },
        }),
    });

    const error = await provider.embedSegment(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwelveLabsShadowAdapterError);
    expect(String(error)).toContain("HTTP 429");
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain("upstream leaked");
  });

  it("aborts bounded shadow requests on timeout", async () => {
    const provider = new TwelveLabsMarengo3ShadowProvider({
      apiKey: "test-key",
      timeoutMs: 1,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    await expect(provider.embedSegment(input)).rejects.toThrow(/timed out/);
  });
});

describe("Marengo registry isolation", () => {
  it("keeps the real provider shadow-only and impossible to resolve authoritatively", () => {
    expect(() =>
      new EmbeddingProviderRouter().resolve({
        selectedProviderId: "twelvelabs-marengo3",
        externalEgressEnabled: true,
        acceptanceState: "passed",
      }),
    ).toThrow(/shadow-only/);
  });
});
