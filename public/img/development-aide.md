# public/img/ : images

| File | Where it shows |
| --- | --- |
| `crystal-mark.png` | The RaveBSD mark: top nav and results bar, phone page headers, notification icon (`app.js`). |
| `favicon.png` | Browser tab icon (`index.html`). |
| `lockup-happy-reading.png`, `lockup-book-search.png` | The two logo lockups that cross-fade on the sign-in and setup screens (`.lockup .a` / `.lockup .b` in `css/app.css`). |

Images here are cached by browsers for a week (`sendFile` in `src/server.js`), so a changed image under the same file name can take up to a week to show everywhere.

The images carry no metadata (EXIF, XMP, PNG text chunks).
