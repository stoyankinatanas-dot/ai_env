import { Hono } from "hono";
import type { Env } from "./types";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}
