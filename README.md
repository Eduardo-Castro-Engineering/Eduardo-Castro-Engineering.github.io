# Eduardo Castro — Portfolio

Personal engineering and astronomy portfolio. Mechanical engineering + astronomy,
Union College '27.

Static site — no build step, no dependencies to install. Open `index.html`, or serve
the folder with any static file server:

```bash
python -m http.server 8000
```

## Layout

| Path | What it is |
|---|---|
| `index.html` | The whole site — markup, styles, and page logic |
| `support.js` | Runtime that expands the page's `<x-dc>` / `<helmet>` wrappers |
| `americas-map.js` | Draws the "where I'm from" journey map (D3 + TopoJSON) |
| `image-slot.js` | Image placement / cropping helper |
| `chroma-video.js` | Removes the flat background from the wireframe clips |
| `assets/` | Images, video, and the interactive viewers' data |
| `assets/docs/` | Full-size source documents; `assets/docs/view/` holds web-sized copies |
| `vendor/` | React 18.3.1, served from this origin instead of a CDN |
| `resume.pdf` | Résumé, linked from the header and footer |

## How it loads

`support.js` hides the raw `<x-dc>` template on sight and renders nothing until
React resolves, so React is on the critical path to first paint. It is therefore
served from `vendor/` on this origin and preloaded in `<head>`, rather than
fetched from a CDN. The files are byte-identical to unpkg's — their SHA-384
hashes match the integrity values inside `support.js` — and they are wired in
through `window.__resources`, the runtime's own override hook, so `support.js`
itself is unmodified.

The font stylesheet and the two map libraries are declared in `<head>` rather
than inside `<helmet>`. The runtime copies `<helmet>` into `<head>` at boot,
which made the browser fetch and re-execute anything declared there a second
time.

## External services used at runtime

Fetched by the visitor's browser, not bundled:

- Google Fonts — Saira, Barlow, Azeret Mono
- unpkg — D3 7.9 and topojson-client 3.1 (`defer`); pdf.js 3.11 on first use only
- jsDelivr — `world-atlas` and `us-atlas` boundary data for the map
- `servicodados.ibge.gov.br` — Brazilian state boundary for the map

Everything above serves one feature each: the map, or the in-page document
viewer. If any is unreachable the rest of the page still renders and only that
feature degrades.

Videos use `preload="metadata"`, and playback is driven by an
`IntersectionObserver` — they download when scrolled to, not on page load.
