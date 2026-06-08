import React from 'react';
import './LetterJumpRail.css';

// '#' collects digits / symbols / non-ASCII titles — the buckets the server's
// /api/library/letters endpoint reports for anything outside A–Z.
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

// Vertical A–Z quick-jump rail for the Library browse grid. Clicking a letter
// asks the host to seek the keyset-paginated grid to that letter's block (see
// GET /api/library?seek=). Only meaningful under the title (A–Z) sort, which
// the host gates before rendering this.
//
// Props:
//   active     — the currently-anchored letter ('#'|'A'..'Z'), or null/'' for
//                the unanchored top-of-list view. Highlights the matching pip.
//   available  — optional Set of buckets that actually have titles. Letters
//                outside it render disabled so the user never jumps to an empty
//                anchor. When null (not loaded / fetch failed) every letter is
//                enabled — the rail degrades to always-clickable rather than
//                blocking navigation.
//   onSelect   — called with the clicked letter.
function LetterJumpRail({ active, available, onSelect }) {
  return (
    <nav className="letter-rail" aria-label="Jump to letter">
      {LETTERS.map(ch => {
        const enabled = !available || available.has(ch);
        const isActive = active === ch;
        return (
          <button
            key={ch}
            type="button"
            className={`letter-rail-btn${isActive ? ' is-active' : ''}`}
            disabled={!enabled}
            aria-pressed={isActive}
            aria-label={ch === '#' ? 'Numbers and symbols' : ch}
            onClick={() => onSelect(ch)}
          >
            {ch}
          </button>
        );
      })}
    </nav>
  );
}

// Memoised: the rail re-renders only when its own props change (`active`
// string, `available` Set reference, stable `onSelect`), not on every unrelated
// Library re-render (search keystrokes, page appends, drawer toggles).
export default React.memo(LetterJumpRail);
