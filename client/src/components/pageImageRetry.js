// Shared <img> error recovery for reader page images.
//
// Reader pages render as plain `<img src=/api/pages/:id/image>`. With Fast
// Chapter Open, a page the user reaches before Phase 2 has extracted it returns
// 503 (Retry-After: 2) — but an <img> can't honour Retry-After on its own, so
// without this the page paints a permanent broken-image even though the bytes
// land moments later. This schedules a bounded, backed-off retry that
// re-points the element at a cache-busted URL so the browser actually
// refetches.
//
// A genuine, non-transient failure (folder page missing, or a corrupt CBZ
// entry that Phase 2 gave up on — now surfaced fast by the server as 404)
// simply exhausts the attempt budget and leaves the broken image. That's the
// pre-feature behaviour, just reached deterministically instead of after a 30s
// hang.

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

// Only http(s) page URLs are retryable. Offline reads use blob: URLs whose
// failure means missing/undecryptable bytes, not a transient extraction race —
// retrying a (possibly revoked) blob URL can never succeed.
function isRetryable(src) {
  return /^https?:/i.test(src || '');
}

// Strip any cache-bust param we previously appended so repeated attempts don't
// accumulate `&_r=` segments and so two URLs for the same page compare equal.
function baseUrl(src) {
  return String(src || '')
    .replace(/([?&])_r=\d+(&|$)/, (_m, p1, p2) => (p2 === '&' ? p1 : ''))
    .replace(/[?&]$/, '');
}

// onError handler for a reader page <img>. Attempt count lives on the element's
// dataset so it survives re-renders without any React state churn.
export function onPageImgError(e) {
  const img = e.currentTarget || e.target;
  if (!img) return;

  const erroredSrc = img.getAttribute('src');
  if (!isRetryable(erroredSrc)) return;

  const base = baseUrl(erroredSrc);
  const attempts = Number(img.dataset.retryAttempts || '0');
  if (attempts >= MAX_ATTEMPTS) return;

  const next = attempts + 1;
  img.dataset.retryAttempts = String(next);

  const sep = base.includes('?') ? '&' : '?';
  window.setTimeout(() => {
    // The element may have been re-pointed at a different page since the error
    // fired (user flipped pages, the scroll list re-keyed). Never yank a live
    // image back to a stale page — abandon the retry if the base URL changed.
    const cur = img.getAttribute('src');
    if (cur && baseUrl(cur) !== base) return;
    img.src = `${base}${sep}_r=${next}`;
  }, BASE_DELAY_MS * next);
}

// Call from the <img> onLoad once it succeeds so a later transient failure on
// the same element starts its attempt budget fresh.
export function onPageImgLoad(img) {
  if (img && img.dataset && img.dataset.retryAttempts) {
    delete img.dataset.retryAttempts;
  }
}
