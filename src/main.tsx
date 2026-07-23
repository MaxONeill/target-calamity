/**
 * Client entry point. Mounts the React tree into #root and pulls in the global
 * layout stylesheet. Everything visual below <App/> is owned by the feature
 * modules (globe, camera, ui) and their co-located CSS; this file only bootstraps.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Fatal: #root mount point missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
