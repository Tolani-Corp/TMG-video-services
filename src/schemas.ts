import { z } from "zod";

export const vectorSearchBodySchema = z.object({
  queryVector: z.array(z.number().finite()).min(1),
  topK: z.number().int().min(1).max(50).default(10),
  namespace: z.string().min(1).max(64),
  tenantId: z.string().min(1).max(64),
  territory: z.string().min(2).max(16).optional(),
});

export const mcpSearchInputSchema = {
  queryVector: z.array(z.number().finite()).min(1),
  topK: z.number().int().min(1).max(25).default(10),
  namespace: z.string().min(1).max(64),
  tenantId: z.string().min(1).max(64),
  territory: z.string().min(2).max(16).optional(),
};
