import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');
// StrictMode intentionally omitted: its dev-only double-mount would spawn a
// PTY, kill it on the fake cleanup, and close the tile via tile:exit.
createRoot(container).render(<App />);
