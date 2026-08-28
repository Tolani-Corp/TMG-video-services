import reviewWorker from "./work-review";
import { REVIEW_CHAIN_JS } from "./work-review-chain-ui";
import type { ReviewEnv } from "./work-review-core";

export { WorkRequestProcessingWorkflow } from "./work-request-processing-workflow";
export { ProcessorChainWorkflow } from "./processor-chain-workflow";
export { MediaExecutionContainer } from "./media-execution-container";

const enhancedReviewWorker = {
  async fetch(request: Request, env: ReviewEnv, ctx: ExecutionContext): Promise<Response> {
    const response = await reviewWorker.fetch(request, env, ctx);
    if (!response.ok) return response;

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/assets/review-chain.js") {
      return new Response(REVIEW_CHAIN_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const html = await response.text();
      const marker = '<script type="module" src="/assets/review.js"></script>';
      const enhanced = html.includes(marker)
        ? html.replace(marker, `<script type="module" src="/assets/review-chain.js"></script>${marker}`)
        : html;
      return new Response(enhanced, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  },
} satisfies ExportedHandler<ReviewEnv>;

export default enhancedReviewWorker;
