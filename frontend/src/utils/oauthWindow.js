// Opens a server-side OAuth consent route in a new tab. A real anchor click is used
// because window.open gets intercepted by some browser extensions; rel="opener" lets
// App.jsx post the callback result back to this window. Only same-origin /oauth/ paths
// are accepted, so a caller can never be turned into an open redirect.
export function openOAuthWindow(href) {
  if (typeof href !== 'string' || !href.startsWith('/oauth/')) return;
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'opener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
