# FroostRook 1.1.0 Beta icon

The official mascot is the frozen-rook artwork supplied by the project owner
(`engine-icon-approved.jpg`, 1024x1024). It is used as supplied; no other
mascot or placeholder is substituted.

Derived assets:

- `engine-icon.png` — 1024x1024 RGBA, rounded-square alpha mask. Outside the
  silhouette alpha is 0; the four frozen background quadrants and the rook are
  unchanged. Corners and the centre were verified after generation.
- `engine-icon.ico` — Windows icon with 16, 32, 48, 64, 96, 128 and 256 px
  images. It is embedded in `FroostRook.exe` through `native/app.rc`.
- `social-preview.png` — 1280x640 repository social card built from the same
  approved icon.

The source JPEG has no alpha channel. The transparency in the PNG/ICO is a
rounded-rectangle mask derived from the artwork; it is not a checkerboard
pattern and does not alter the illustration inside the silhouette.
