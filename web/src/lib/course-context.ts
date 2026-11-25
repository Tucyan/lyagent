import { navigateWithinApp } from "./app-navigation";

export const ACTIVE_COURSE_STORAGE_KEY = "course-agent:active-course";
export const COURSE_CHANGED_EVENT = "course-agent:course-changed";

export function readCourseFromUrl(search = typeof window !== "undefined" ? window.location.search : ""): string {
  return new URLSearchParams(search).get("course") ?? "";
}

export function readStoredCourseId(): string {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_COURSE_STORAGE_KEY) ?? "" : "";
  } catch {
    return "";
  }
}

export function writeStoredCourseId(courseId: string): void {
  try {
    if (typeof window === "undefined") return;
    if (courseId) window.localStorage.setItem(ACTIVE_COURSE_STORAGE_KEY, courseId);
    else window.localStorage.removeItem(ACTIVE_COURSE_STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
}

export function resolveActiveCourseId(
  courses: ReadonlyArray<{ id: string }>,
  preferredCourseId = readCourseFromUrl(),
): string {
  if (preferredCourseId && courses.some((course) => course.id === preferredCourseId)) {
    writeStoredCourseId(preferredCourseId);
    return preferredCourseId;
  }
  const stored = readStoredCourseId();
  if (stored && courses.some((course) => course.id === stored)) {
    return stored;
  }
  const fallback = courses[0]?.id ?? "";
  writeStoredCourseId(fallback);
  return fallback;
}

export function withCourseQuery(href: string, courseId: string): string {
  if (!courseId) return href;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1";
  const url = new URL(href, origin);
  url.searchParams.set("course", courseId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function notifyCoursesUpdated(activeCourseId?: string): void {
  if (activeCourseId !== undefined) writeStoredCourseId(activeCourseId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(COURSE_CHANGED_EVENT, { detail: { courseId: activeCourseId } }));
  }
}

export function selectActiveCourse(courseId: string, targetPath?: string): void {
  writeStoredCourseId(courseId);
  if (typeof window === "undefined") return;
  const basePath = targetPath ?? `${window.location.pathname}${window.location.search}`;
  const url = new URL(basePath, window.location.origin);
  const previousCourseId = url.searchParams.get("course");
  if (targetPath === undefined && url.pathname === "/qa" && previousCourseId && previousCourseId !== courseId) {
    url.searchParams.delete("session");
  }
  if (courseId) url.searchParams.set("course", courseId);
  else url.searchParams.delete("course");
  navigateWithinApp(`${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new CustomEvent(COURSE_CHANGED_EVENT, { detail: { courseId } }));
}
