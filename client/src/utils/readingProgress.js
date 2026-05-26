// Per-device, per-user intra-chapter resume position. Stored in localStorage so
// each browser/install remembers where the user stopped reading independently
// of the server-side `progress` table (which tracks completed chapters and
// drives AniList sync).
//
// Keyed by the active user so two accounts sharing one device don't clobber
// each other's resume page:
//   localStorage[`momotaro_resume_<userId>_<mangaId>`] = JSON({ chapterId, page, updatedAt })
//
// `userId` comes from `momotaro_active_user_id` (set by the API client on
// login/register; absent in single-user / pre-accounts mode, where it falls
// back to 'default'). Pre-accounts keys (`momotaro_resume_<mangaId>`) are
// migrated lazily on first read so no resume position is lost on upgrade.

function activeUserId() {
  try {
    return localStorage.getItem('momotaro_active_user_id') || 'default';
  } catch {
    return 'default';
  }
}

function key(mangaId) {
  return `momotaro_resume_${activeUserId()}_${mangaId}`;
}

function legacyKey(mangaId) {
  return `momotaro_resume_${mangaId}`;
}

export function getResume(mangaId) {
  if (!mangaId) return null;
  try {
    let raw = localStorage.getItem(key(mangaId));
    if (raw === null) {
      // One-time migration of a pre-accounts un-namespaced entry to the
      // current user's namespace, then drop the legacy key.
      const legacy = localStorage.getItem(legacyKey(mangaId));
      if (legacy !== null) {
        localStorage.setItem(key(mangaId), legacy);
        localStorage.removeItem(legacyKey(mangaId));
        raw = legacy;
      }
    }
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
  try {
    localStorage.removeItem(key(mangaId));
    localStorage.removeItem(legacyKey(mangaId)); // also drop any legacy entry
  } catch { /* ignore */ }
}
