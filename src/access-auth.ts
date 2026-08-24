export interface ConsoleActor {
  email: string;
  name: string | null;
}

export class AccessRequiredError extends Error {
  constructor(message = "Cloudflare Access authentication is required") {
    super(message);
    this.name = "AccessRequiredError";
  }
}

export async function requireConsoleActor(ctx: ExecutionContext): Promise<ConsoleActor> {
  if (!ctx.access) {
    throw new AccessRequiredError();
  }

  const identity = await ctx.access.getIdentity();
  const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
  if (!email) {
    throw new AccessRequiredError("Cloudflare Access identity is missing an email claim");
  }

  return {
    email,
    name: typeof identity?.name === "string" && identity.name.trim() ? identity.name.trim() : null,
  };
}
