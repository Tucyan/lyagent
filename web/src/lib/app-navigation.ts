export function navigateWithinApp(href: string, replace = false): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
