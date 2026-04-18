// Per-device intra-chapter resume position. Stored in localStorage so each
// browser/install remembers where the user stopped reading independently of
// the server-side `progress` table (which still tracks completed chapters
// and drives AniList sync).
//
// Shape: localStorage[`momotaro_resume_${mangaId}`] = JSON({ chapterId, page, updatedAt })

function key(mangaId) {
  return `momotaro_resume_${mangaId}`;
}

export function getResume(mangaId) {
  if (!mangaId) return null;
  try {
    const raw = localStorage.getItem(key(mangaId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isInteger(parsed.chapterId) || !Number.isInteger(parsed.page)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Returns the saved page if the entry matches `chapterId` and is past page 0.
export function getResumePageForChapter(mangaId, chapterId) {
  const entry = getResume(mangaId);
  if (!entry) return null;
  if (entry.chapterId !== Number(chapterId)) return null;
  if (entry.page <= 0) return null;
  return entry.page;
}

export function setResume(mangaId, chapterId, page) {
  if (!mangaId || !chapterId || !Number.isInteger(page)) return;
  try {
    localStorage.setItem(key(mangaId), JSON.stringify({
      chapterId: Number(chapterId),
      page,
      updatedAt: Date.now(),
    }));
  } catch { /* quota or disabled storage — ignore */ }
}

export function clearResume(mangaId) {
  if (!mangaId) return;
  try { localStorage.removeItem(key(mangaId)); } catch { /* ignore */ }
}
