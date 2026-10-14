# Offline board handwriting fonts

These unmodified WOFF2 subsets are distributed under the SIL Open Font License
1.1 in `OFL.txt`. Family-specific copyright and upstream modification notices
are in `Excalifont-NOTICE.txt` and `Xiaolai-NOTICE.txt`.

Source: the Excalidraw project's font assets, retrieved 2026-09-12:

- https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Excalifont
- https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Xiaolai

`manifest.json` records the upstream filenames and Unicode ranges. The desktop
plugin reads these files from its own installation directory. No font request
is sent to a CDN. Font faces are loaded separately for each document/window;
SVG previews embed only the subsets required by their handwritten text.

Keep this directory together with `main.js`, `manifest.json` and `styles.css`
when installing or distributing the plugin. The build, packaging and developer
installation scripts include it automatically.
