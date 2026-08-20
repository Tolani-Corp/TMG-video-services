export class VectorizeMutationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorizeMutationContractError";
  }
}

export function requireVectorizeAsyncMutationId(result: unknown): string {
  if (typeof result !== "object" || result === null || !("mutationId" in result)) {
    throw new VectorizeMutationContractError(
      "Vectorize V2 async mutation response with mutationId is required.",
    );
  }

  const mutationId = (result as { mutationId?: unknown }).mutationId;
  if (typeof mutationId !== "string" || mutationId.length === 0) {
    throw new VectorizeMutationContractError(
      "Vectorize mutation response contained an invalid mutationId.",
    );
  }

  return mutationId;
}
