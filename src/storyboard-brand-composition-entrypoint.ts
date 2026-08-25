export { StoryboardBrandCompositionWorkflow } from "./storyboard-brand-composition-workflow";

export default {
  async fetch(): Promise<Response> {
    return Response.json(
      {
        service: "tmg-storyboard-brand-composition-v1.1",
        mode: "review_only",
        generatedImageModel: "@cf/black-forest-labs/flux-1-schnell",
        exactCompositionProvider: "cloudflare_images_binding",
        preferredVideoProvider: "pruna/p-video",
        paidProviderExecutionAuthorized: false,
        humanReviewRequired: true,
        publicationAuthority: false,
        externalDistributionAuthority: false,
      },
      {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;
