import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rubric conversation presentation", () => {
  it("renders assistant markdown as one continuous document instead of paragraph bubbles", async () => {
    const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

    expect(css).toContain(".rubric-chat-message.assistant .rubric-message-content p");
    expect(css).toMatch(/\.rubric-chat-message\.assistant \.rubric-message-content p\s*\{[^}]*max-width:\s*none;[^}]*padding:\s*0;[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.rubric-chat-message\.assistant \.rubric-message-content (?:ul|ol)[^}]*padding-left:/s);
  });
});
