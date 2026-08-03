import { describe, expect, it } from "vitest";
import { withJsonHeaders } from "../web/src/lib/api.js";

describe("withJsonHeaders", () => {
  it("does not declare JSON for a bodyless request", () => {
    const request = withJsonHeaders({ method: "POST" });

    expect(new Headers(request.headers).has("content-type")).toBe(false);
  });

  it("declares JSON when it sends a body", () => {
    const request = withJsonHeaders({ method: "POST", body: JSON.stringify({ name: "course" }) });

    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
  });
});
