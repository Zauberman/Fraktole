import React from 'react';

/** Minimal typing for the Electron <webview> element used by the Test tab.
 *  Events are attached imperatively (addEventListener) — React's synthetic
 *  event system does not know these custom events. */

export interface WebviewConsoleMessageEvent {
  level: number; // 0 verbose, 1 info, 2 warning, 3 error
  message: string;
}

export interface WebviewDidNavigateEvent {
  url: string;
}

export interface WebviewDidFailLoadEvent {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

export interface WebviewTag extends HTMLElement {
  src: string;
  loadURL(url: string, options?: Record<string, unknown>): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  openDevTools(options?: { mode?: 'detach' | 'right' | 'bottom' }): void;
  closeDevTools(): void;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        webpreferences?: string;
        allowpopups?: string;
        ref?: React.Ref<WebviewTag>;
      };
    }
  }
}
