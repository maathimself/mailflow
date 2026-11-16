// The backend caps a page at 500 rows; asking for more makes the list silently shrink, so a
// longer window is fetched in parts (fetchListWindow).
const MAX_LIMIT = 500;

// Which rows a background refresh (new mail, sync, flag changes) reloads.
//
// Paginated mode reloads the page on screen. Infinite mode reloads everything already scrolled
// into view, and never less than one page: the loaded count is a floor, not the window. A list
// that first loaded 1 message (a new account, or a nearly empty folder) otherwise asked for
// limit=1 on every refresh after it, so mail arriving next never showed until a reload (#682).
export function refreshListWindow({ scrollMode, currentPage = 1, pageSize, loadedCount = 0 }) {
  const size = Math.max(1, Number(pageSize) || 50);
  if (scrollMode === 'paginated') {
    const page = Math.max(1, Number(currentPage) || 1);
    return { limit: size, offset: (page - 1) * size };
  }
  return { limit: Math.max(Number(loadedCount) || 0, size), offset: 0 };
}

// Whether rows exist past a page. The total comes from the folder's counters, which can run ahead
// of the rows that can be listed, so a page that came back short is the end whatever the total
// says; otherwise Load more stayed up and returned nothing, every time (#743). The server applies
// no filter after its LIMIT, so a short page is never one cut in the middle.
export function hasMoreRows({ fetched, limit, offset = 0, total }) {
  const asked = Math.min(Math.max(1, Number(limit) || 50), MAX_LIMIT);
  return fetched >= asked && offset + fetched < (Number(total) || 0);
}

// Fetch a window of rows from offset 0, in parts of at most MAX_LIMIT, so a refresh of a long
// scrolled list keeps every row instead of cutting it back to 500 (#743). Stops at a short part.
// A row seen twice (mail arriving between parts shifts the list) is kept once.
// fetchPage({ limit, offset }) resolves to { messages, total }.
export async function fetchListWindow(fetchPage, { limit }) {
  const rows = [];
  let total = 0;
  let fetched = 0;
  let lastFull = true;
  while (fetched < limit) {
    const want = Math.min(MAX_LIMIT, limit - fetched);
    const data = await fetchPage({ limit: want, offset: fetched });
    const part = data?.messages || [];
    total = data?.total ?? total;
    rows.push(...part);
    fetched += part.length;
    lastFull = part.length >= want;
    if (!lastFull) break;
  }
  const seen = new Set();
  const messages = rows.filter(m => {
    if (m?.id == null) return true;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return { messages, total, fetched, hasMore: lastFull && fetched < total };
}

// Fetch a page of a paginated list, moving back when it came back empty: mail deleted or moved
// elsewhere can leave the page on screen past the end, and the list sat on an empty page (#743).
// Tries the last page the total allows, then page 1, so a counter running ahead of the rows
// costs at most three requests. Resolves to { messages, total, page }.
export async function fetchPageOrLast(fetchPage, { page, pageSize }) {
  const size = Math.max(1, Number(pageSize) || 50);
  let p = Math.max(1, Number(page) || 1);
  for (let attempt = 0; ; attempt++) {
    const data = await fetchPage({ limit: size, offset: (p - 1) * size });
    if ((data?.messages || []).length || p === 1) return { ...data, page: p };
    const last = Math.max(1, Math.ceil((Number(data?.total) || 0) / size));
    p = attempt === 0 ? Math.min(p - 1, last) : 1;
  }
}

// A background refresh that arrives while the list is loading cannot run then: it would race the
// load, or a load-more's append. It used to be dropped, so mail whose new_messages event landed
// during the first load of a new account, or during a load-more, stayed hidden until the next
// event or a reload. The gate holds one back and hands it over when the load settles.
export function createTrailingRefresh() {
  let pending = false;
  return {
    // True when the refresh may run now; false when it was held back for settle().
    request(loading) {
      if (loading) { pending = true; return false; }
      pending = false;
      return true;
    },
    // True once per held-back refresh, when the load it waited for has finished.
    settle() {
      const held = pending;
      pending = false;
      return held;
    },
  };
}
