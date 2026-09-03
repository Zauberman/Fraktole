import React, { useEffect, useRef, useState } from 'react';
import { bridge } from '../ipc.js';
import type {
  WebviewConsoleMessageEvent,
  WebviewDidFailLoadEvent,
  WebviewDidNavigateEvent,
  WebviewTag,
} from '../webview.d.js';

interface TestTabProps {
  sessionId: string;
  /** Set by App when the reviewer's open_test_page lands; consumed here. */
  pendingUrl: string | null;
  onPendingUrlConsumed(): void;
  /** True while the Test tab is the active top-bar tab. */
  active: boolean;
}

function normalize(raw: string): string {
  const target = raw.trim();
  if (target.length === 0) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`;
}

/**
 * The Test tab: a fully functional embedded mini browser for exercising the
 * agents' results (webapps on dev servers, built artifacts). The guest runs
 * in its own sandboxed renderer process with a separate storage partition;
 * popups navigate in-tab; console errors surface as a badge; DevTools open
 * for the guest page.
 */
export function TestTab(props: TestTabProps): React.JSX.Element {
  const { sessionId, pendingUrl, onPendingUrlConsumed, active } = props;
  const [url, setUrl] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const wvRef = useRef<WebviewTag | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const consoleRef = useRef<Array<{ level: number; message: string }>>([]);

  // reviewer-driven navigation (open_test_page)
  useEffect(() => {
    if (!pendingUrl) return;
    const target = normalize(pendingUrl);
    if (target.length > 0) {
      setInput(target);
      setUrl(target);
      setFailed(null);
      setErrors(0);
      consoleRef.current = [];
    }
    onPendingUrlConsumed();
  }, [pendingUrl, onPendingUrlConsumed]);

  const load = (raw: string): void => {
    const target = normalize(raw);
    if (target.length === 0) return;
    setInput(target);
    setUrl(target);
    setFailed(null);
    setErrors(0);
    consoleRef.current = [];
  };

  // imperative webview listeners (React does not know these events); the
  // guest must emit dom-ready before ANY property or method is touched —
  // accessing the webview earlier throws a fatal Electron error
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onReady = (): void => setReady(true);
    const onStart = (): void => setLoading(true);
    const onStop = (): void => setLoading(false);
    const onNav = (e: Event): void => {
      const ev = e as unknown as WebviewDidNavigateEvent;
      setUrl(ev.url);
      setInput(ev.url);
      setFailed(null);
    };
    const onFail = (e: Event): void => {
      const ev = e as unknown as WebviewDidFailLoadEvent;
      if (ev.isMainFrame) {
        setLoading(false);
        setFailed(ev.errorDescription);
      }
    };
    const onConsole = (e: Event): void => {
      const ev = e as unknown as WebviewConsoleMessageEvent;
      if (ev.level >= 3) setErrors((n) => n + 1);
      consoleRef.current = [...consoleRef.current.slice(-19), { level: ev.level, message: ev.message }];
    };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('console-message', onConsole);
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('console-message', onConsole);
    };
    // `failed` is load-bearing: when it clears, the <webview> remounts and
    // the effect must re-attach to the fresh element (retry would otherwise
    // leave the toolbar permanently disabled)
  }, [url, failed]);

  // push navigations into the guest (only after dom-ready)
  useEffect(() => {
    const wv = wvRef.current;
    if (wv && ready && url.length > 0 && wv.src !== url) wv.src = url;
  }, [url, ready]);

  // read_test_page round-trip
  useEffect(() => {
    const unsub = bridge.onTestStateRequest(sessionId, ({ requestId }) => {
      const wv = ready ? wvRef.current : null;
      const state = {
        url: wv && wv.getURL() ? wv.getURL() : url,
        title: wv ? wv.getTitle() : '',
        loading,
        consoleErrors: errors,
        console: consoleRef.current,
      };
      void bridge.testStateResponse(sessionId, requestId, state);
    });
    return unsub;
  }, [sessionId, url, loading, errors, ready]);

  // reload_test_page round-trip
  useEffect(() => {
    const unsub = bridge.onTestReload(sessionId, () => {
      if (!ready) return;
      setErrors(0);
      consoleRef.current = [];
      wvRef.current?.reload();
    });
    return unsub;
  }, [sessionId, ready]);

  // screenshot_test_page round-trip: capture only while the tab is visible
  useEffect(() => {
    const unsub = bridge.onTestScreenshotRequest(sessionId, ({ requestId }) => {
      const wv = ready ? wvRef.current : null;
      if (!active || !wv) {
        void bridge.testScreenshotResponse(sessionId, requestId, null);
        return;
      }
      void wv
        .capturePage()
        .then((img) => bridge.testScreenshotResponse(sessionId, requestId, img.toDataURL()))
        .catch(() => bridge.testScreenshotResponse(sessionId, requestId, null));
    });
    return unsub;
  }, [sessionId, active, ready]);

  // ctrl+L focuses the URL bar while the tab is active
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!active) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [active]);

  const devtools = (): void => {
    if (ready) wvRef.current?.openDevTools({ mode: 'detach' });
  };

  return (
    <div className="test-tab">
      <div className="test-toolbar">
        <button type="button" className="test-btn" title="back" disabled={!ready} onClick={() => (ready ? wvRef.current?.goBack() : undefined)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M7.5 2.5 L4 6 L7.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
          </svg>
        </button>
        <button type="button" className="test-btn" title="forward" disabled={!ready} onClick={() => (ready ? wvRef.current?.goForward() : undefined)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
          </svg>
        </button>
        <button type="button" className="test-btn" title="reload" onClick={() => (ready ? (loading ? wvRef.current?.stop() : wvRef.current?.reload()) : undefined)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M9.5 6 A3.5 3.5 0 1 1 8 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
            <path d="M8 1.5 L8 3.6 L5.9 3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
          </svg>
        </button>
        <input
          ref={inputRef}
          className="test-url"
          value={input}
          placeholder="enter a URL — the agent's dev server, a built artifact…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load(input);
          }}
          spellCheck={false}
        />
        <span className={`test-loading${loading ? ' test-loading-on' : ''}`} aria-hidden="true" />
        {errors > 0 && (
          <button type="button" className="test-err-badge" title="console errors — click for DevTools" onClick={devtools}>
            {errors} error{errors === 1 ? '' : 's'}
          </button>
        )}
        <button type="button" className="test-btn" title="devtools" onClick={devtools}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1.5" y="3.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4 3.5 V2.5 A2 2 0 0 1 8 2.5 V3.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
      {failed !== null ? (
        <div className="test-error">
          <div className="test-error-title">failed to load</div>
          <div className="test-error-message">{failed}</div>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => load(url)}>
            retry
          </button>
        </div>
      ) : (
        <webview ref={wvRef} src={url} partition="persist:fraktest" webpreferences="contextIsolation=yes,sandbox=yes" allowpopups="" />
      )}
    </div>
  );
}
