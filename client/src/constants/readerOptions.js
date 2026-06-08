// Shared option lists for the reader's preference controls. The in-reader
// settings panel (ReaderControls) and Settings → Reading (ReadingSection)
// render the same choices, so the {value,label} data lives here in one place
// while each surface keeps its own wrapping markup and classNames. Treat these
// as immutable — render only, never sort/push the imported reference.

export const READING_MODE_OPTIONS = [
  { value: 'ltr',      label: 'Left to Right' },
  { value: 'rtl',      label: 'Right to Left' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'webtoon',  label: 'Webtoon' },
];

export const ORIENTATION_OPTIONS = [
  { value: 'ltr', label: 'Left to Right' },
  { value: 'rtl', label: 'Right to Left' },
];

export const PAGE_TRANSITION_OPTIONS = [
  { value: 'off',   label: 'Off' },
  { value: 'slide', label: 'Slide' },
  { value: 'fade',  label: 'Fade' },
  { value: 'curl',  label: 'Curl' },
];

export const BG_COLOR_OPTIONS = [
  { value: 'black', label: 'Black' },
  { value: 'gray',  label: 'Gray' },
  { value: 'white', label: 'White' },
];
