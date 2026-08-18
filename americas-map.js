/* <americas-map> — self-playing camera over real geometry.
   Basemap rasterises on canvas from Path2D built once; markers stay in SVG for crisp text.
   Data: world-atlas countries (110m), us-atlas states (10m), IBGE malha for Minas Gerais. */
(function () {
  if (customElements.get('americas-map')) return;

  const W_URL  = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";
  const US_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json";
  const MG_URL = "https://servicodados.ibge.gov.br/api/v3/malhas/estados/31?formato=application/vnd.geo+json&qualidade=intermediaria";

  const CITY = {
    sch: { lon: -73.9396, lat: 42.8142, name: "Schenectady, NY", co: "42.8142° N   73.9396° W" },
    fit: { lon: -71.8023, lat: 42.5834, name: "Fitchburg, MA",   co: "42.5834° N   71.8023° W" },
    ipa: { lon: -42.5369, lat: -19.4683, name: "Ipatinga, MG",   co: "19.4683° S   42.5369° W" }
  };

  // rect = [west, north, east, south]
  const STEPS = [
    { rect: [-170, 73, -48, 12],          hl: null, mk: null,  off: 0 },
    { rect: [-81, 45.6, -70.2, 40.2],     hl: "ny", mk: "sch", off: 1 },
    { rect: [-74.4, 43.3, -69.1, 40.9],   hl: "ma", mk: "fit", off: 1 },
    { rect: [-52.4, -13.2, -38.8, -23.6], hl: "mg", mk: "ipa", off: 1, dur: 3400 }
  ];

  const AMERICAS = { type: "Polygon", coordinates: [[[-172, 76], [-28, 76], [-28, -58], [-172, -58], [-172, 76]]] };
  const VW = 4000, PPD = VW / 144;
  const TRANS = 1600, HOLD = 3200, LOOP = 2400;
  const STAR = "M0,-1 L.2245,-.309 L.951,-.309 L.3633,.1181 L.588,.809 L0,.382 L-.588,.809 L-.3633,.1181 L-.951,-.309 L-.2245,-.309 Z";

  const TOKENS = {
    landFill:  "color-mix(in srgb, var(--text,#29331A) 8%, transparent)",
    landLine:  "color-mix(in srgb, var(--text,#29331A) 30%, transparent)",
    grat:      "color-mix(in srgb, var(--text,#29331A) 11%, transparent)",
    mesh:      "color-mix(in srgb, var(--text,#29331A) 19%, transparent)",
    hlFill:    "color-mix(in srgb, var(--accent,#B1723B) 44%, transparent)",
    hlLine:    "var(--accent,#B1723B)"
  };

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const smooth = t => t * t * (3 - 2 * t);

  async function libs() {
    for (let i = 0; i < 400 && !(window.d3 && window.topojson); i++) await new Promise(r => setTimeout(r, 40));
    if (!(window.d3 && window.topojson)) throw new Error("d3/topojson unavailable");
  }

  class AmericasMap extends HTMLElement {
    constructor() {
      super();
      this._sig = -1; this._ready = false;
      this.cur = 0; this.playing = false;
      this.anim = { from: 0, to: 0, t: 1, dur: TRANS };
      this.tick = this.tick.bind(this);
      this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      this.shadowRoot.innerHTML = `
<style>
  :host{display:block;position:relative;width:100%;height:100%;overflow:hidden}
  canvas,svg{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
  .link{fill:none;stroke:var(--accent,#B1723B);stroke-width:2.6;stroke-linecap:round}
  .star{fill:var(--band,#29331A)}
  .ring{fill:none;stroke:var(--band,#29331A);stroke-width:1.6;opacity:.5;
        animation:pulse 2.8s cubic-bezier(.22,.61,.36,1) infinite;transform-origin:center;transform-box:fill-box}
  .halo{fill:var(--accent,#B1723B);opacity:.3}
  .lbl{fill:var(--text,#29331A);font:700 13px/1 var(--mono,ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase}
  .co{fill:color-mix(in srgb,var(--text,#29331A) 58%,transparent);font:400 10.5px/1 var(--mono,ui-monospace,monospace);letter-spacing:.08em}
  @keyframes pulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(3.6);opacity:0}100%{transform:scale(3.6);opacity:0}}
  @media (prefers-reduced-motion: reduce){.ring{animation:none}}
  .probe{position:absolute;width:0;height:0;visibility:hidden}
</style>
<canvas></canvas>
<svg aria-hidden="true"><g class="ovl"></g></svg>
<i class="probe"></i>`;
      this.cv = this.shadowRoot.querySelector("canvas");
      this.ctx = this.cv.getContext("2d");
      this.ovl = this.shadowRoot.querySelector(".ovl");
      this.probe = this.shadowRoot.querySelector(".probe");

      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(this);
      this.io = new IntersectionObserver(es => { this.draw(); es[0].isIntersecting ? this.play() : this.pause(); }, { threshold: 0.05 });
      this.io.observe(this);
      this.watch = setInterval(() => this.check(), 400);
      this.mo = new MutationObserver(() => { this.palette(); this._sig = -1; this.draw(); });
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
      this.boot();
    }

    disconnectedCallback() {
      this.pause();
      clearInterval(this.watch);
      [this.ro, this.io, this.mo].forEach(o => o && o.disconnect());
    }

    get steps() { return STEPS.length; }

    palette() {
      const cs = getComputedStyle(this.probe);
      this.pal = {};
      for (const k in TOKENS) { this.probe.style.color = TOKENS[k]; this.pal[k] = cs.color; }
      this.probe.style.color = "";
    }

    check() {
      if (!this._ready) return;
      const r = this.getBoundingClientRect();
      if (r.height > 2 && r.bottom > innerHeight * 0.12 && r.top < innerHeight * 0.88) { this.draw(); this.play(); }
      else this.pause();
    }

    play() {
      if (this.playing || !this._ready) return;
      this.playing = true;
      this.draw();
      if (this.anim.t >= 1) {
        const wait = this._begun ? HOLD : HOLD * 0.5;
        this._begun = true;
        this.holdTimer = setTimeout(() => this.advance(), wait);
      }
      else { this.anim.t0 = performance.now() - this.anim.t * this.anim.dur; this.raf = requestAnimationFrame(this.tick); }
    }

    pause() {
      this.playing = false;
      clearTimeout(this.holdTimer);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    advance() {
      if (!this.playing) return;
      const N = STEPS.length;
      const from = this.cur, to = (this.cur + 1) % N;
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.anim = { from, to, dur: still ? 1 : (STEPS[to].dur || (to === 0 ? LOOP : TRANS)), t0: performance.now(), t: 0 };
      this.cur = to;
      this.dispatchEvent(new CustomEvent("map-step", { bubbles: true, detail: { index: to } }));
      this.raf = requestAnimationFrame(this.tick);
    }

    tick(ts) {
      if (!this.playing) return;
      const a = this.anim;
      a.t = clamp((ts - a.t0) / a.dur, 0, 1);
      this.draw();
      if (a.t < 1) this.raf = requestAnimationFrame(this.tick);
      else { this.raf = 0; this.holdTimer = setTimeout(() => this.advance(), HOLD); }
    }

    async boot() {
      try {
        await libs();
        const [wt, ut, mg] = await Promise.all([
          fetch(W_URL).then(r => r.json()),
          fetch(US_URL).then(r => r.json()),
          fetch(MG_URL).then(r => r.json()).catch(() => null)
        ]);

        const d3 = window.d3, topojson = window.topojson;
        const countries = topojson.feature(wt, wt.objects.countries).features;
        const states = topojson.feature(ut, ut.objects.states).features;

        const proj = d3.geoMercator().precision(0.2);
        proj.fitWidth(VW, AMERICAS);
        this.proj = proj;

        // thin the vertex count in projected space; rasterising is then cheap at every zoom
        const decim = min => {
          let x0 = 0, y0 = 0, first = true;
          return d3.geoTransform({
            lineStart() { first = true; this.stream.lineStart(); },
            point(x, y) {
              if (first || Math.abs(x - x0) + Math.abs(y - y0) > min) { first = false; x0 = x; y0 = y; this.stream.point(x, y); }
            }
          });
        };
        const P = min => d3.geoPath({ stream: s => proj.stream(decim(min).stream(s)) }).digits(1);
        const coarse = P(1.1), mid = P(0.5), fine = P(0.18), bulk = P(1.8);

        const mgF = mg && mg.features && mg.features[0];
        if (mgF && d3.geoArea(mgF) > 2 * Math.PI) {
          const g0 = mgF.geometry;
          if (g0.type === "Polygon") g0.coordinates.forEach(r => r.reverse());
          else if (g0.type === "MultiPolygon") g0.coordinates.forEach(pp => pp.forEach(r => r.reverse()));
        }

        // one Path2D per feature/segment with its projected bounds, so frames can cull
        const bounder = d3.geoPath(proj);
        const piece = (pathFn, feat) => {
          const d = pathFn(feat);
          if (!d) return null;
          const b = bounder.bounds(feat);
          return { p: new Path2D(d), b: [b[0][0], b[0][1], b[1][0], b[1][1]] };
        };
        const pieces = (pathFn, feats) => feats.map(x => piece(pathFn, x)).filter(Boolean);

        const meshLines = topojson.mesh(ut, ut.objects.states, (a, b) => a !== b).coordinates;
        const segs = [];
        meshLines.forEach(line => {
          for (let s = 0; s < line.length - 1; s += 260)
            segs.push({ type: "LineString", coordinates: line.slice(s, Math.min(line.length, s + 261)) });
        });
        const natF = topojson.feature(ut, ut.objects.nation);
        const nation = [];
        (natF.features ? natF.features.map(x => x.geometry) : [natF.geometry]).forEach(gm => {
          if (!gm) return;
          if (gm.type === "MultiPolygon") gm.coordinates.forEach(poly => nation.push({ type: "Polygon", coordinates: poly }));
          else nation.push(gm);
        });

        this.geo = {
          grat: new Path2D(coarse(d3.geoGraticule().step([10, 10])())),
          land: pieces(coarse, countries.filter(x => x.id !== "840" &&
            (c => c[0] > -172 && c[0] < -28 && c[1] > -58 && c[1] < 76)(d3.geoCentroid(x)))),
          us:     pieces(fine, nation),
          usFar:  pieces(coarse, nation),
          mesh:   pieces(mid, segs),
          meshFar: pieces(bulk, segs),
          ny:   new Path2D(fine(states.find(x => x.properties.name === "New York"))),
          ma:   new Path2D(fine(states.find(x => x.properties.name === "Massachusetts"))),
          mg:   mgF ? new Path2D(fine(mgF)) : null
        };

        const NS = "http://www.w3.org/2000/svg";
        const mk = (tag, attrs, parent) => {
          const el = document.createElementNS(NS, tag);
          for (const k in attrs) el.setAttribute(k, attrs[k]);
          parent.appendChild(el);
          return el;
        };
        this.link = mk("path", { class: "link", opacity: "0" }, this.ovl);
        this.marks = {};
        for (const key in CITY) {
          const c = CITY[key];
          const grp = mk("g", { opacity: "0" }, this.ovl);
          const pin = mk("g", {}, grp);
          mk("circle", { class: "halo", r: "13" }, pin);
          mk("circle", { class: "ring", r: "9" }, pin);
          mk("path", { class: "star", d: STAR, transform: "scale(9)" }, pin);
          const t1 = mk("text", { class: "lbl", x: "20", y: "6" }, pin); t1.textContent = c.name.toUpperCase();
          const t2 = mk("text", { class: "co", x: "20", y: "22" }, pin); t2.textContent = c.co;
          this.marks[key] = { grp, pin, xy: proj([c.lon, c.lat]), on: false };
        }

        this.palette();
        this._ready = true;
        this.draw();
        requestAnimationFrame(() => this.draw());
        this.dispatchEvent(new CustomEvent("map-ready", { bubbles: true }));
        this.check();
      } catch (e) {
        console.warn("americas-map:", e.message);
      }
    }

    fit(rect) {
      const [w, n, e, s] = rect;
      const a = this.proj([w, n]), c = this.proj([e, s]);
      const x0 = Math.min(a[0], c[0]), x1 = Math.max(a[0], c[0]);
      const y0 = Math.min(a[1], c[1]), y1 = Math.max(a[1], c[1]);
      const kx = this.w / (x1 - x0), ky = this.h / (y1 - y0);
      const kc = Math.min(kx, ky), kv = Math.max(kx, ky);
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: kc * Math.pow(kv / kc, 0.35) };
    }

    anchor(off) { return off ? (this.narrow ? [0.5, 0.36] : [0.53, 0.5]) : [0.5, 0.5]; }

    draw() {
      if (!this._ready) return;
      const ow = this.offsetWidth, oh = this.offsetHeight;
      if (ow < 2 || oh < 2) return;
      if (ow !== this.w || oh !== this.h) {
        this.w = ow; this.h = oh;
        this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
        this.cv.width = Math.round(ow * this.dpr);
        this.cv.height = Math.round(oh * this.dpr);
        this.svg = this.svg || this.shadowRoot.querySelector("svg");
        this.svg.setAttribute("viewBox", `0 0 ${ow} ${oh}`);
        this.narrow = ow < 820;
        this._sig = -1;
      }

      const i = this.anim.from, j = this.anim.to;
      const t = ease(this.anim.t);
      const sig = i * 1e7 + j * 1e6 + Math.round(this.anim.t * 1e5);
      if (sig === this._sig) return;
      this._sig = sig;

      const A = this.fit(STEPS[i].rect), B = this.fit(STEPS[j].rect);
      const v = window.d3.interpolateZoom([A.cx, A.cy, this.w / A.k], [B.cx, B.cy, this.w / B.k])(t);
      const k = this.w / v[2];
      const a0 = this.anchor(STEPS[i].off), a1 = this.anchor(STEPS[j].off);
      const ax = a0[0] + (a1[0] - a0[0]) * t, ay = a0[1] + (a1[1] - a0[1]) * t;
      const tx = this.w * ax - k * v[0], ty = this.h * ay - k * v[1];

      this.paint(k, tx, ty, i, j, t);
      this.pins(k, tx, ty, i, j, this.anim.t);
    }

    paint(k, tx, ty, i, j, t) {
      const c = this.ctx, p = this.pal, g = this.geo, d = this.dpr;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.cv.width, this.cv.height);
      c.setTransform(d * k, 0, 0, d * k, d * tx, d * ty);
      c.lineJoin = "round";

      const deg = (this.w / k) / PPD;
      const gratA = clamp((deg - 9) / 16, 0, 1);
      if (gratA > 0.01) {
        c.globalAlpha = gratA; c.strokeStyle = p.grat; c.lineWidth = 0.8 / k; c.stroke(g.grat);
      }

      const mx = 24 / k;
      const vx0 = -tx / k - mx, vy0 = -ty / k - mx;
      const vx1 = (this.w - tx) / k + mx, vy1 = (this.h - ty) / k + mx;
      const near = [];
      const gather = (arr) => {
        near.length = 0;
        for (let n = 0; n < arr.length; n++) {
          const b = arr[n].b;
          if (b[0] <= vx1 && b[2] >= vx0 && b[1] <= vy1 && b[3] >= vy0) near.push(arr[n].p);
        }
        return near;
      };

      c.globalAlpha = clamp((deg - 8) / 12, 0.35, 1);
      c.fillStyle = p.landFill; c.strokeStyle = p.landLine; c.lineWidth = 1 / k;
      for (const q of gather(g.land)) { c.fill(q, "evenodd"); c.stroke(q); }

      c.globalAlpha = 1;
      const far = deg > 26;
      for (const q of gather(far ? g.usFar : g.us)) { c.fill(q, "evenodd"); c.stroke(q); }

      if (deg <= 62) {
        c.strokeStyle = p.mesh; c.lineWidth = 0.9 / k;
        for (const q of gather(far ? g.meshFar : g.mesh)) c.stroke(q);
      }

      const paintHl = (key, alpha) => {
        if (!key || alpha < 0.004 || !g[key]) return;
        c.globalAlpha = alpha;
        c.fillStyle = p.hlFill; c.fill(g[key], "evenodd");
        c.strokeStyle = p.hlLine; c.lineWidth = 2.2 / k; c.stroke(g[key]);
      };
      if (STEPS[i].hl === STEPS[j].hl) paintHl(STEPS[i].hl, 1);
      else { paintHl(STEPS[i].hl, 1 - t); paintHl(STEPS[j].hl, t); }
      c.globalAlpha = 1;
    }

    pins(k, tx, ty, i, j, t) {
      const mIn = smooth(clamp((t - 0.18) / 0.3, 0, 1));
      const mOut = 1 - smooth(clamp((t - 0.72) / 0.28, 0, 1));
      const at = (key) => {
        const m = this.marks[key];
        return [tx + k * m.xy[0], ty + k * m.xy[1]];
      };
      const wt = {};
      for (const key in this.marks) {
        const m = this.marks[key];
        const w = clamp((STEPS[i].mk === key ? mOut : 0) + (STEPS[j].mk === key ? mIn : 0), 0, 1);
        wt[key] = w;
        if (w <= 0.001) { if (m.on) { m.grp.setAttribute("opacity", "0"); m.on = false; } continue; }
        m.on = true;
        m.grp.setAttribute("opacity", w.toFixed(3));
        const p = at(key);
        m.pin.setAttribute("transform", `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`);
      }
      this.trail(i, j, t, at, wt);
    }

    // curved route line between the departing and arriving stars.
    // The camera cannot frame both ends on the hemisphere leg, so the curve is
    // clipped to the viewport and simply runs off the edge — it reads as a route.
    trail(i, j, t, at, wt) {
      const a = STEPS[i].mk, b = STEPS[j].mk;
      if (!a || !b || a === b || t <= 0.001) { this.link.setAttribute("opacity", "0"); return; }

      const A = at(a), B = at(b);
      const dx = B[0] - A[0], dy = B[1] - A[1], dd = Math.hypot(dx, dy) || 1;
      let nx = -dy / dd, ny = dx / dd;
      if (ny > 0) { nx = -nx; ny = -ny; }                       // bow toward the top of the frame
      const bow = Math.min(dd * 0.19, Math.min(this.w, this.h) * 0.42);
      const qx = (A[0] + B[0]) / 2 + nx * bow, qy = (A[1] + B[1]) / 2 + ny * bow;

      const trim = (from, toward, px) => {                      // clear the star glyphs
        const ux = toward[0] - from[0], uy = toward[1] - from[1], ud = Math.hypot(ux, uy) || 1;
        return [from[0] + (ux / ud) * px, from[1] + (uy / ud) * px];
      };
      const S = trim(A, [qx, qy], 22), E = trim(B, [qx, qy], 22);

      const N = 56, pts = [];
      for (let n = 0; n <= N; n++) {
        const u = n / N, iu = 1 - u;
        pts.push([iu * iu * S[0] + 2 * iu * u * qx + u * u * E[0],
                  iu * iu * S[1] + 2 * iu * u * qy + u * u * E[1]]);
      }

      const pad = 60, x0 = -pad, y0 = -pad, x1 = this.w + pad, y1 = this.h + pad;
      const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
      let d = "", open = false, drawn = 0;
      for (let n = 0; n < pts.length; n++) {
        const p = pts[n], vis = inside(p);
        if (vis && !open) {
          const prev = pts[n - 1];                              // step one sample outside so the line meets the edge
          d += "M" + (prev || p)[0].toFixed(1) + "," + (prev || p)[1].toFixed(1);
          if (prev) d += "L" + p[0].toFixed(1) + "," + p[1].toFixed(1);
          open = true; drawn++;
        } else if (vis) {
          d += "L" + p[0].toFixed(1) + "," + p[1].toFixed(1);
          drawn++;
        } else if (open) {
          d += "L" + p[0].toFixed(1) + "," + p[1].toFixed(1);
          open = false;
        }
      }
      if (drawn < 2) { this.link.setAttribute("opacity", "0"); return; }

      this.link.setAttribute("d", d);
      this.link.removeAttribute("stroke-dasharray");
      this.link.removeAttribute("stroke-dashoffset");
      const fade = smooth(clamp((t - 0.14) / 0.14, 0, 1)) * (1 - smooth(clamp((t - 0.9) / 0.1, 0, 1)));
      const ends = Math.pow(Math.min(wt[a], wt[b]), 0.6);   // never brighter than the stars it joins
      this.link.setAttribute("opacity", (fade * ends * 0.95).toFixed(3));
    }
  }

  customElements.define("americas-map", AmericasMap);
})();
