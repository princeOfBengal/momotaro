import React, { useCallback, useEffect, useRef, useState } from 'react';
import { __attachDialogHost } from './dialogService';
import { acquireScrollLock } from './scrollLock';
import './Dialog.css';

// Renders the active dialog produced by the imperative `appAlert /
// appConfirm / appPrompt` helpers. The provider just plugs itself into
// the dialog service on mount; everything else flows through the
// service's queue.
export default function DialogProvider({ children }) {
  const [config, setConfig]   = useState(null);
  const [pwValue, setPwValue] = useState('');
  const onCloseRef = useRef(null);
  // Whichever element should receive focus when the dialog opens:
  //   - prompt → the text input (so the user can type immediately)
  //   - alert / confirm → the primary action button (so Enter triggers it)
  const focusRef = useRef(null);

  useEffect(() => {
    const detach = __attachDialogHost((cfg, resolve) => {
      onCloseRef.current = resolve;
      setPwValue(cfg.type === 'prompt' ? (cfg.defaultValue || '') : '');
      setConfig(cfg);
    });
    return detach;
  }, []);

  useEffect(() => {
    if (!config) return;
    // Lock body scroll while a dialog is up — matches the native modal
    // contract callers were relying on with `window.confirm`. Goes
    // through the shared refcount so a stacked AdminUnlockDialog doesn't
    // race the cleanup hooks.
    return acquireScrollLock();
  }, [config]);

  useEffect(() => {
    if (!config || !focusRef.current) return;
    focusRef.current.focus?.();
    // For prompts, also select() the prefilled value so the user can
    // immediately start typing OR overwrite the suggestion.
    if (config.type === 'prompt') focusRef.current.select?.();
  }, [config]);

  const close = useCallback((result) => {
    const cb = onCloseRef.current;
    onCloseRef.current = null;
    setConfig(null);
    if (cb) cb(result);
  }, []);

  function handleKeyDown(e) {
    if (!config) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (config.type === 'alert')   close(undefined);
      if (config.type === 'confirm') close(false);
      if (config.type === 'prompt')  close(null);
      return;
    }
    // Don't synthesise an Enter action when focus is on a button or input —
    // the browser already turns Enter into a click (for buttons) or a form
    // submit (for inputs inside the prompt form). Intercepting here would
    // double-fire (e.g. pressing Enter while Cancel is focused on a confirm
    // would still trigger OK).
    if (e.key === 'Enter') {
      const tag = e.target?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (config.type === 'prompt') return; // form handles its own submit
      e.preventDefault();
      if (config.type === 'alert')   close(undefined);
      if (config.type === 'confirm') close(true);
    }
  }

  return (
    <>
      {children}
      {config && (
        <div
          className="app-dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-dialog-title"
          onKeyDown={handleKeyDown}
          // Backdrop click cancels — matches Escape behaviour.
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            if (config.type === 'alert')   close(undefined);
            if (config.type === 'confirm') close(false);
            if (config.type === 'prompt')  close(null);
          }}
        >
          <div
            className={`app-dialog app-dialog-${config.type}${config.danger ? ' app-dialog-danger' : ''}`}
          >
            <h2 id="app-dialog-title" className="app-dialog-title">
              {config.title || defaultTitle(config.type)}
            </h2>
            <p className="app-dialog-message">{config.message}</p>

            {config.type === 'prompt' && (
              <form
                className="app-dialog-form"
                onSubmit={(e) => { e.preventDefault(); close(pwValue); }}
              >
                <input
                  ref={focusRef}
                  type={config.inputType || 'text'}
                  className="app-dialog-input"
                  value={pwValue}
                  onChange={(e) => setPwValue(e.target.value)}
                  placeholder={config.placeholder || ''}
                  autoComplete={config.autoComplete || 'off'}
                />
                <div className="app-dialog-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => close(null)}
                  >{config.cancelLabel || 'Cancel'}</button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                  >{config.okLabel || 'OK'}</button>
                </div>
              </form>
            )}

            {config.type === 'confirm' && (
              <div className="app-dialog-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => close(false)}
                >{config.cancelLabel || 'Cancel'}</button>
                <button
                  ref={focusRef}
                  type="button"
                  className={`btn ${config.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => close(true)}
                >{config.okLabel || 'OK'}</button>
              </div>
            )}

            {config.type === 'alert' && (
              <div className="app-dialog-actions">
                <button
                  ref={focusRef}
                  type="button"
                  className="btn btn-primary"
                  onClick={() => close(undefined)}
                >{config.okLabel || 'OK'}</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function defaultTitle(type) {
  if (type === 'confirm') return 'Confirm';
  if (type === 'prompt')  return 'Enter value';
  return 'Notice';
}
