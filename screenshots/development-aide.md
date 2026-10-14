# screenshots/ : README pictures

Screenshots of RaveBSD 2.0 used by the root `README.md`. They are not part of the app and are not copied into the Docker image (only `src/` and `public/` are).

- `desktop-*.png`: 1440px wide desktop views (Discover, Advanced search, Searching, Results for ebooks and audiobooks, Shelf, Stats, the admin panel's Libraries).
- `phone-*.png`: phone views of the same pages.
- `thumbs/`: small JPEG versions for the README's clickable grid. Each thumbnail links to its full-size PNG here.

## How they are made

- Taken from a test instance with throwaway data. No real folder names, account names, emails, addresses or library logins are visible; anything that would have been is painted over.
- All metadata (EXIF, XMP, PNG text chunks) is stripped.
- `README.md` refers to each one by file name, in both the `<a href>` and the `<img src>`.
- Each has a matching thumbnail in `thumbs/` (same base name, `.jpg`).
