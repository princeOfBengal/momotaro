import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

// Shared left-rail sidebar for Home and Library. Holds the Home shortcut,
// the Libraries list, and the Reading Lists (with in-place create + delete).
//
// Styling lives in pages/Library.css under the `.library-sidebar*` class
// family — both host pages already import that file, so no CSS duplication.
//
// Selection is decoupled from the host page so Library can drive its grid
// state in place while Home navigates the user over to /library with the
// chosen filter in React Router's location state.
//
// Props:
//   libraries, readingLists      — data arrays (caller owns the fetch so
//                                  this component stays stateless)
//   activeLibrary, activeList    — currently selected IDs (null on Home)
//   onSelectAll, onSelectLibrary, onSelectList
//                                — optional callbacks. When omitted, the
//                                  sidebar navigates to /library with the
//                                  matching location.state.
//   drawerOpen, onCloseDrawer    — mobile drawer state (managed by host)
//   onReadingListsChanged        — called after successful create/delete so
//                                  the host can refetch the list counts
export default function AppSidebar({
  libraries = [],
  readingLists = [],
  activeLibrary = null,
  activeList = null,
  onSelectAll,
  onSelectLibrary,
  onSelectList,
  drawerOpen = false,
  onCloseDrawer,
  onReadingListsChanged,
}) {
  const navigate = useNavigate();
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName]   = useState('');
  const [savingList, setSavingList]     = useState(false);
  const newListInputRef = useRef(null);

  useEffect(() => {
    if (creatingList) newListInputRef.current?.focus();
  }, [creatingList]);

  function closeDrawer() {
    onCloseDrawer?.();
  }

  // When the host doesn't pass its own selection handlers, fall back to
  // navigation. Library uses in-place setState; Home uses navigation.
  const handleAll = () => {
    closeDrawer();
    if (onSelectAll) onSelectAll();
    else navigate('/library');
  };
  const handleLibrary = (id) => {
    closeDrawer();
    if (onSelectLibrary) onSelectLibrary(id);
    else navigate('/library', { state: { library: id } });
  };
  const handleList = (id) => {
    closeDrawer();
    if (onSelectList) onSelectList(id);
    else navigate('/library', { state: { list: id } });
  };

  async function handleCreateList(e) {
    e.preventDefault();
    if (!newListName.trim() || savingList) return;
    setSavingList(true);
    try {
      await api.createReadingList({ name: newListName.trim() });
      setNewListName('');
      setCreatingList(false);
      onReadingListsChanged?.();
    } catch (err) {
      alert('Failed to create list: ' + err.message);
    } finally {
      setSavingList(false);
    }
  }

  async function handleDeleteList(e, id) {
    e.stopPropagation();
    try {
      await api.deleteReadingList(id);
      // If the host is currently filtering by this list, unwind that
      // filter before re-fetching. Only applies on the Library page.
      if (activeList === id && onSelectAll) onSelectAll();
      onReadingListsChanged?.();
    } catch (err) {
      alert('Failed to delete list: ' + err.message);
    }
  }

  const isViewingAll = activeLibrary === null && activeList === null;

  return (
    <aside className={`library-sidebar${drawerOpen ? ' drawer-open' : ''}`}>
      <div className="lib-drawer-header">
        <span className="lib-drawer-title">Menu</span>
        <button
          className="lib-drawer-close"
          onClick={closeDrawer}
          aria-label="Close menu"
        >✕</button>
      </div>

      {/* Home shortcut — always first, above Libraries. */}
      <Link
        to="/"
        className="library-sidebar-item library-sidebar-home"
        onClick={closeDrawer}
      >
        <svg
          className="library-sidebar-home-icon"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
        </svg>
        Home
      </Link>
      <div className="library-sidebar-divider" />

      {/* Libraries */}
      {libraries.length > 0 && (
        <>
          <p className="library-sidebar-heading">Libraries</p>
          {libraries.length > 1 && (
            <button
              className={`library-sidebar-item${isViewingAll && onSelectAll ? ' active' : ''}`}
              onClick={handleAll}
            >
              All Libraries
              <span className="library-sidebar-count">
                {libraries.reduce((s, l) => s + l.manga_count, 0)}
              </span>
            </button>
          )}
          {libraries.map(lib => (
            <button
              key={lib.id}
              className={`library-sidebar-item${activeLibrary === lib.id ? ' active' : ''}`}
              onClick={() => handleLibrary(lib.id)}
            >
              {lib.name}
              <span className="library-sidebar-count">{lib.manga_count}</span>
            </button>
          ))}
          <div className="library-sidebar-divider" />
        </>
      )}

      {/* Reading Lists */}
      <div className="library-sidebar-section-header">
        <p className="library-sidebar-heading">Reading List</p>
        {!creatingList && (
          <button
            className="library-sidebar-add-btn"
            onClick={() => setCreatingList(true)}
            title="New reading list"
          >+</button>
        )}
      </div>

      {readingLists.map(list => (
        <div key={list.id} className="library-sidebar-item-row">
          <button
            className={`library-sidebar-item${activeList === list.id ? ' active' : ''}`}
            onClick={() => handleList(list.id)}
          >
            {list.name}
            <span className="library-sidebar-count">{list.manga_count}</span>
          </button>
          {!list.is_default && (
            <button
              className="library-sidebar-delete-btn"
              onClick={e => handleDeleteList(e, list.id)}
              title={`Delete "${list.name}"`}
            >×</button>
          )}
        </div>
      ))}

      {creatingList && (
        <form className="library-sidebar-new-list" onSubmit={handleCreateList}>
          <input
            ref={newListInputRef}
            className="library-sidebar-new-list-input"
            type="text"
            placeholder="List name..."
            value={newListName}
            onChange={e => setNewListName(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setCreatingList(false)}
            maxLength={60}
          />
          <div className="library-sidebar-new-list-actions">
            <button
              type="submit"
              className="library-sidebar-new-list-save"
              disabled={!newListName.trim() || savingList}
            >
              Add
            </button>
            <button
              type="button"
              className="library-sidebar-new-list-cancel"
              onClick={() => { setCreatingList(false); setNewListName(''); }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
