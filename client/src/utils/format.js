// Shared formatters used across Settings sections and beyond. Kept
// dependency-free so they're cheap to import from anywhere — never reach for
// React, dates libraries, or i18n machinery here.

export function formatElapsed(sec) {
  if (sec == null) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatNextRun(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month:   'short',
      day:     'numeric',
      hour:    '2-digit',
      minute:  '2-digit',
    });
  } catch {
    return null;
  }
}

// Render one axis of a chapter/volume span: "15" for a single number, "17-18"
// for a range (a single file/folder can cover multiple chapters or volumes).
// `end` is null/undefined for a single value, so old data without range columns
// gracefully renders the start alone.
export function fmtSpan(start, end) {
  return end != null && end !== start ? `${start}-${end}` : `${start}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatReadTime(minutes) {
  if (!minutes) return '0 min';
  if (minutes < 60) return `${minutes} min`;
  const h = (minutes / 60).toFixed(1);
  return `${h} hr${h === '1.0' ? '' : 's'}`;
}

export function formatRelativeTime(unixSec) {
  if (!unixSec) return 'never';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60)       return 'just now';
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatCountdown(expiresUnix) {
  const remaining = Math.max(0, expiresUnix - Math.floor(Date.now() / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatAbsoluteTime(unixSec) {
  if (!unixSec) return '';
  try {
    return new Date(unixSec * 1000).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return new Date(unixSec * 1000).toISOString(); }
}

export function formatApkSize(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
