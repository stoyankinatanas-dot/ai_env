import { describe, it, expect } from "vitest";
import { exports } from "cloudflare:workers";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await exports.default.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
