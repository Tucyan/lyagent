import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const base = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const polish = readFileSync(new URL("../web/src/styles/ux-polish.css", import.meta.url), "utf8");

it.each([
  [".admin-brand", ["padding"]],
  [".admin-nav-label", ["margin", "color", "font-size", "font-weight"]],
  [".rubric-page-header", ["min-height", "align-items", "gap", "padding", "border-bottom", "background"]],
  [".rubric-session-row", ["position", "display"]],
  [".rubric-session-row > button", ["padding", "border", "color", "background", "font-size", "opacity"]],
  [".grading-header", ["display", "align-items", "gap", "min-height", "padding", "border-bottom"]],
  [".grading-new-dialog", ["gap", "width", "padding", "border", "border-radius", "box-shadow"]],
] as const)("%s declares shared component overrides in the later stylesheet", (selector, properties) => {
  const declarations = (stylesheet: string) => {
    const prefix = "\n" + selector + " {";
    const start = stylesheet.indexOf(prefix);
    return start === -1 ? "" : stylesheet.slice(start + prefix.length, stylesheet.indexOf("\n}", start));
  };
  for (const property of properties) {
    const declaration = new RegExp("(^|\\n)\\s*" + property + "\\s*:");
    expect(declarations(polish), property).toMatch(declaration);
    expect(declarations(base), property).not.toMatch(declaration);
  }
});
