import type { Context, Next } from "hono";
import type { z } from "zod";
import { badRequest } from "./errors.js";

/**
 * Request validation (Epic 2.1): the one way a route declares the JSON body
 * it accepts, so Epic 2.2's CRUD endpoints validate the same way this
 * module's own routes do — never a hand-rolled check per route.
 */
export function validateJsonBody<Schema extends z.ZodTypeAny>(schema: Schema) {
  return async (
    c: Context<{ Variables: { body: z.infer<Schema> } }>,
    next: Next,
  ) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw badRequest("request body must be valid JSON");
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      throw badRequest("request body failed validation", result.error.issues);
    }

    c.set("body", result.data);
    await next();
  };
}
