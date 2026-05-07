import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import MangaCard from './MangaCard';
import { useGridColumnCount } from '../hooks/useGridColumnCount';
import './VirtualizedMangaGrid.css';

// Approximate non-cover height of a card: title (≤ 2 lines @ 13px × 1.3) +
// year (12px) + the 8px flex gap between cover and meta block + 2px year
// margin. measureElement corrects this after the first paint, so the only
// cost of being slightly wrong is a small scrollbar adjustment.
const CARD_META_HEIGHT_PX = 64;

// How many rows away from the end before we fire onEndReached. 3 rows of
// overscan match the existing 200 px IntersectionObserver rootMargin closely
// enough that the user keeps the same "loads before I scroll there" feel.
const DEFAULT_END_REACHED_THRESHOLD = 3;

// Renders a long list of manga cards using @tanstack/react-virtual against a
// caller-supplied scroll container. Only the rows currently in (or near) the
// viewport are mounted, which keeps DOM size constant regardless of how many
// items are in `items`.
//
// Props:
//   items                  — full data array (search results or browse pages)
//   scrollElementRef       — ref to the scrolling element; usually the
//                            <main className="library-main"> node
//   onEndReached           — optional; called when the last visible row is
//                            within `endReachedThreshold` rows of the end.
//                            Fires at most once per `items.length` change.
//   endReachedThreshold    — defaults to 3 rows
//   renderEmpty            — optional fallback when `items.length === 0`
//
// CSS variables read from the wrapper's computed style (cascaded from
// .library-main per breakpoint):
//   --col-min  minimum column width in px (matches `minmax(<min>, 1fr)`)
//   --col-gap  grid gap in px
export default function VirtualizedMangaGrid({
  items,
  scrollElementRef,
  onEndReached,
  endReachedThreshold = DEFAULT_END_REACHED_THRESHOLD,
}) {
  const wrapperRef = useRef(null);
  const { cols, gap, containerWidth } = useGridColumnCount(wrapperRef);

  // Column width derived the same way the browser would: subtract inter-column
  // gaps from the available width and divide. Used only for height estimation;
  // the row's own grid layout sizes cells via `1fr`.
  const colWidth = cols > 0 && containerWidth > 0
    ? (containerWidth - (cols - 1) * gap) / cols
    : 0;

  // Cover is 2:3 aspect → height = colWidth × 1.5. We fold the inter-row gap
  // into each row's `padding-bottom` so measureElement's reported height
  // already accounts for spacing (no cumulative drift).
  const estimatedRowHeight = colWidth > 0
    ? Math.round(colWidth * 1.5 + CARD_META_HEIGHT_PX + gap)
    : 320;

  const safeCols = Math.max(1, cols);
  const rowCount = items.length === 0 ? 0 : Math.ceil(items.length / safeCols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 4,
  });

  // When column count changes (resize or breakpoint cross), invalidate the
  // measurement cache — every row's old height is now wrong because column
  // width changed.
  useLayoutEffect(() => {
    virtualizer.measure();
  // virtualizer is a stable ref; safeCols is the actual trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeCols, estimatedRowHeight]);

  // Fire onEndReached when the last visible row is near the end. Guarded so
  // it only fires once per `items.length` value: when loadMore appends new
  // rows, items.length changes and we re-arm.
  const lastFiredAtLengthRef = useRef(-1);
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!onEndReached) return;
    if (virtualItems.length === 0) return;
    if (rowCount === 0) return;
    const lastVisibleRow = virtualItems[virtualItems.length - 1].index;
    if (lastVisibleRow >= rowCount - endReachedThreshold
        && lastFiredAtLengthRef.current !== items.length) {
      lastFiredAtLengthRef.current = items.length;
      onEndReached();
    }
  }, [virtualItems, rowCount, items.length, onEndReached, endReachedThreshold]);

  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={wrapperRef}
      className="virt-grid-wrap"
      style={{ height: rowCount === 0 ? 'auto' : totalSize }}
    >
      {virtualItems.map(virtualRow => {
        const startIdx = virtualRow.index * safeCols;
        const rowItems = items.slice(startIdx, startIdx + safeCols);
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="virt-grid-row"
            style={{
              transform: `translateY(${virtualRow.start}px)`,
              gridTemplateColumns: `repeat(${safeCols}, minmax(0, 1fr))`,
              columnGap: `${gap}px`,
              paddingBottom: `${gap}px`,
            }}
          >
            {rowItems.map(m => (
              <Link key={m.id} to={`/manga/${m.id}`} className="virt-grid-cell">
                <MangaCard manga={m} />
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}
