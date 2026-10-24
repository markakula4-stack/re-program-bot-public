const workersStub =
  "data:text/javascript," +
  encodeURIComponent("export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: workersStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
