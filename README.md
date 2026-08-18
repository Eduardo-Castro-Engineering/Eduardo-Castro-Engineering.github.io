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
| `resume.pdf` | Résumé, linked from the header and footer |

## External services used at runtime

Loaded from a CDN by the visitor's browser, not bundled:

- Google Fonts — Saira, Barlow, Azeret Mono
- unpkg — D3 7.9, topojson-client 3.1, pdf.js 3.11, React 18.3
- jsDelivr — `world-atlas` and `us-atlas` boundary data for the map
- `servicodados.ibge.gov.br` — Brazilian state boundary for the map

If any of these are unreachable the rest of the page still renders; only the feature
that depends on them degrades.
