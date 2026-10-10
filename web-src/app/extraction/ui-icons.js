// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const UI_ICON_PATHS = {
  grind: 'M5 3v2m0 6v10M12 3v10m0 6v2M19 3v4m0 6v8M5 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  dose: 'M12 3v17M5 20h14M4 7h16M6 7l-4 7h8L6 7Zm12 0-4 7h8l-4-7Z',
  yield: 'M4 7h13v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V7Zm13 1h2a3 3 0 0 1 0 6h-2M7 3v1M11 3v1M15 3v1',
  timer: 'M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 10v4l3 2M9 2h6M12 2v4M18 7l2-2',
  edit: 'm15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15v6Z',
  live: 'M2 12h5l3-8 4 16 3-8h5',
  history: 'M3 10a9 9 0 1 1 1 9M3 4v6h6M12 7v5l4 2',
  refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1',
  stack: 'M3 3h15v14H3V3Zm4 14v4h14V7h-3',
  chevronRight: 'm9 6 6 6-6 6',
};

// Decorative icons accompany a visible label or a labeled action.
function uiIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    class: 'ui-icon', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.6',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', UI_ICON_PATHS[name]);
  svg.append(path);
  return svg;
}
