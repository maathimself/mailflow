// Frontend plugin registrations — import each bundled plugin for its side-effecting slot
// registrations. Imported once at app startup (main.jsx) before the tree renders, so a plugin's
// slot contributions exist by first paint. Mirrors the backend's loadBundledPlugins.
import './gtd/index.jsx';
import './template-builder/index.jsx';
