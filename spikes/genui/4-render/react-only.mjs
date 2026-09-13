// Baseline for the bundle-size comparison: React and nothing else.
/* global document -- runs in the browser */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
createRoot(document.body).render(createElement('p', null, 'x'));
