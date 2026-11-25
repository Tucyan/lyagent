// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectActiveCourse } from "../web/src/lib/course-context.js";

beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("clears the previous course's QA session and keeps the old conversation in browser history", async () => {
  const original = "/qa?course=course-one&session=session-one";
  window.history.replaceState(null, "", original);

  selectActiveCourse("course-two");

  expect(window.location.pathname + window.location.search).toBe("/qa?course=course-two");
  window.history.back();
  await vi.waitFor(() => expect(window.location.pathname + window.location.search).toBe(original));
});

it("keeps the QA session when selecting the same course or navigating to an explicit conversation", () => {
  const original = "/qa?course=course-one&session=session-one";
  window.history.replaceState(null, "", original);

  selectActiveCourse("course-one");
  expect(window.location.pathname + window.location.search).toBe(original);

  selectActiveCourse("course-two", "/qa?course=course-two&session=session-two");
  expect(window.location.pathname + window.location.search).toBe("/qa?course=course-two&session=session-two");
});
