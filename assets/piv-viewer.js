/* ============================================================================
   PIV FLOW-FIELD VIEWER
   Renders the 150 °C heated-rough-wall PIV ensemble averages that ship in
   piv-150c.js.  Two surfaces:

     · the porthole   — the fluids bubble's picture, cycling heater on ->
                        heater off -> the difference, morphing between them
     · the full figure — inside <dialog id="p-piv">, with axes, a colour bar,
                        a magnifier lens under the cursor and a readout of
                        every measured quantity at that point

   Everything is drawn per display pixel: the grid is bilinearly sampled and
   then quantised into contour bands, so band edges stay crisp at any zoom
   instead of blurring the way an upscaled bitmap would.

   Colour limits, band counts, axis window and the jet colour map are the ones
   stored inside the saved MATLAB figures (Uon.fig, Uoff.fig, Uon-Uoff(New).fig,
   Von.fig, Voff.fig, Von-Voff(New).fig), so this agrees with the paper plots.
   ============================================================================ */
(function () {
  'use strict';

  var D   = window.PIV150;
  var pic = document.getElementById('piv-pic');
  if (!pic) return;

  var CAN_DECODE = typeof DecompressionStream !== 'undefined' &&
                   typeof Blob !== 'undefined' && !!(Blob.prototype && Blob.prototype.stream);
  if (!D || !CAN_DECODE) { pic.dataset.failed = '1'; return; }

  /* ---------------------------------------------------------------- constants */
  var NX = D.nx, NY = D.ny, X0 = D.x0, DX = D.dx, Y0 = D.y0, DY = D.dy;

  var XMIN = -3, XMAX = 218, YMIN = -3, YMAX = 123;   // axes window from the .fig files
  var ASPECT = (YMAX - YMIN) / (XMAX - XMIN);         // MATLAB used axis equal

  var VARS = {
    U: { label: 'U  (m/s)', name: 'streamwise velocity',
         clim: { on: [-0.38389, 2.93155], off: [-0.38389, 2.93155], diff: [-0.5, 0.2] } },
    V: { label: 'V  (m/s)', name: 'wall-normal velocity',
         clim: { on: [-0.1558, 0.41614], off: [-0.1558, 0.41614], diff: [-0.1, 0.1] } }
  };
  var BANDS   = { on: 22, off: 22, diff: 21 };
  var TITLE   = { on: 'Heater On', off: 'Heater Off', diff: 'Heater On − Off' };
  var COL     = { on: '1', off: '2', diff: '3' };
  var ORDER   = ['on', 'off', 'diff'];
  var QUANTS  = ['U', 'V', 'uu', 'uv', 'vv'];

  /* Halved from 620 / 2600 / 900 — the porthole now advances a frame every
     1.75 s instead of 3.5 s, and the full figure re-solves twice as quickly
     when you change component or heater case. */
  var MORPH = 310, HOLD = 1300, THUMB_MORPH = 450;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --------------------------------------------------- decode the data payload */
  function bytesFromB64(b64) {
    var s = atob(b64), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }

  /* IEEE half -> double.  Subnormals matter here: many stress values sit far
     below 2^-14, and clamping them to zero would quietly alter the data. */
  function half(h) {
    var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0)  return s * 5.9604644775390625e-8 * m;   // 2^-24 * m
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 25) * (1024 + m);          // 2^(e-15) * (1 + m/1024)
  }

  function inflate(bytes) {
    var st = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(st).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /* Bytes arrive plane-split — every high byte, then every low byte — because the
     high plane is smooth and deflates well while the mantissa tail does not. */
  function decodeField(entry) {
    return inflate(bytesFromB64(entry.z)).then(function (raw) {
      var n = entry.n, out = new Float32Array(n);
      for (var i = 0; i < n; i++) out[i] = half((raw[i] << 8) | raw[n + i]);
      return out;
    });
  }

  /* All three cases — including the difference — arrive already computed at full
     precision.  Subtracting two stored half-precision values in here instead
     would leave quantisation noise in the digits the readout prints. */
  var F = {};
  function loadAll() {
    return Promise.all(Object.keys(D.fields).map(function (k) {
      return decodeField(D.fields[k]).then(function (a) { F[k] = a; });
    }));
  }

  /* ------------------------------------------------------------ colour mapping */
  var lutCache = {};
  function lut(n) {                                    // MATLAB jet, band centres
    if (lutCache[n]) return lutCache[n];
    var a = new Uint8Array(n * 3);
    for (var k = 0; k < n; k++) {
      var t = (k + 0.5) / n;
      a[3 * k]     = 255 * clamp01(1.5 - Math.abs(4 * t - 3));
      a[3 * k + 1] = 255 * clamp01(1.5 - Math.abs(4 * t - 2));
      a[3 * k + 2] = 255 * clamp01(1.5 - Math.abs(4 * t - 1));
    }
    return (lutCache[n] = a);
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /* ------------------------------------------------------------------ sampling */
  /* nearest measured node — what the readout quotes, so the numbers are values
     that were actually measured rather than an interpolation of them */
  function nodeAt(x, y) {
    var i = Math.round((x - X0) / DX), j = Math.round((y - Y0) / DY);
    if (i < 0 || j < 0 || i >= NX || j >= NY) return null;
    return { i: i, j: j, k: j * NX + i, x: X0 + i * DX, y: Y0 + j * DY };
  }

  /* --------------------------------------------------------------- field paint */
  /* Per-pixel index arithmetic is the same for every row of a column and every
     column of a row, so it is hoisted into tables that only rebuild when the
     canvas size or the data window actually changes.  The arrays are parked on
     the canvas, so a resize reallocates but a redraw never does. */
  function axisTable(cv, W, H, xa, xb, ya, yb) {
    var key = W + '|' + H + '|' + xa + '|' + xb + '|' + ya + '|' + yb;
    var g = cv._ax;
    if (g && g.key === key) return g;
    if (!g || g.W !== W || g.H !== H) {
      g = cv._ax = {
        W: W, H: H,
        i0: new Int32Array(W), i1: new Int32Array(W), fx: new Float32Array(W),
        j0: new Int32Array(H), j1: new Int32Array(H), fy: new Float32Array(H),
        okX: new Uint8Array(W), okY: new Uint8Array(H)
      };
    }
    g.key = key;
    var sx = (xb - xa) / W, sy = (yb - ya) / H, q, t;
    for (q = 0; q < W; q++) {
      t = ((xa + (q + 0.5) * sx) - X0) / DX;
      if (t >= 0 && t <= NX - 1) {
        var i = t | 0;
        g.okX[q] = 1; g.i0[q] = i; g.i1[q] = i + 1 < NX ? i + 1 : i; g.fx[q] = t - i;
      } else g.okX[q] = 0;
    }
    for (q = 0; q < H; q++) {
      t = ((yb - (q + 0.5) * sy) - Y0) / DY;
      if (t >= 0 && t <= NY - 1) {
        var j = t | 0;
        g.okY[q] = 1; g.j0[q] = j; g.j1[q] = j + 1 < NY ? j + 1 : j; g.fy[q] = t - j;
      } else g.okY[q] = 0;
    }
    return g;
  }

  /* Fills img with the window [xa,xb] x [ya,yb] in mm.  fA/fB and climA/climB are
     blended by t, which is what makes one case morph into the next. */
  function paintField(img, W, H, ax, fA, fB, t, climA, climB, nb) {
    var px = img.data, table = lut(nb);
    var lo = climA[0] + (climB[0] - climA[0]) * t;
    var hi = climA[1] + (climB[1] - climA[1]) * t;
    var inv = 1 / (hi - lo), p = 0;
    var one = t <= 0 ? fA : (t >= 1 ? fB : null);   // no blend needed at the ends
    var i0a = ax.i0, i1a = ax.i1, fxa = ax.fx, okX = ax.okX;

    for (var py = 0; py < H; py++) {
      if (!ax.okY[py]) { px.fill(0, p, p + W * 4); p += W * 4; continue; }
      var r0 = ax.j0[py] * NX, r1 = ax.j1[py] * NX, fy = ax.fy[py];
      for (var qx = 0; qx < W; qx++, p += 4) {
        if (!okX[qx]) { px[p] = px[p + 1] = px[p + 2] = px[p + 3] = 0; continue; }
        var i0 = i0a[qx], i1 = i1a[qx], fx = fxa[qx], v, a, b, c, d, u0, u1;

        a = (one || fA)[r0 + i0]; b = (one || fA)[r0 + i1];
        c = (one || fA)[r1 + i0]; d = (one || fA)[r1 + i1];
        /* a hole anywhere in the cell makes the whole cell a hole: a rejected
           vector must not be smeared into neighbours it never measured */
        if (a !== a || b !== b || c !== c || d !== d) { px[p + 3] = 0; continue; }
        u0 = a + (b - a) * fx; u1 = c + (d - c) * fx;
        v = u0 + (u1 - u0) * fy;

        if (!one) {
          a = fB[r0 + i0]; b = fB[r0 + i1]; c = fB[r1 + i0]; d = fB[r1 + i1];
          if (a !== a || b !== b || c !== c || d !== d) { px[p + 3] = 0; continue; }
          u0 = a + (b - a) * fx; u1 = c + (d - c) * fx;
          v += ((u0 + (u1 - u0) * fy) - v) * t;
        }

        var s = (v - lo) * inv;
        var k = (s < 0 ? 0 : s > 1 ? 1 : s) * nb | 0;
        if (k >= nb) k = nb - 1;
        k *= 3;
        px[p] = table[k]; px[p + 1] = table[k + 1]; px[p + 2] = table[k + 2]; px[p + 3] = 255;
      }
    }
  }

  function scratch(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* The ImageData is parked on the canvas and reused.  Allocating a fresh one
     per frame would churn megabytes through the collector mid-animation. */
  function fieldToCanvas(cv, xa, xb, ya, yb, fA, fB, t, climA, climB, nb) {
    var g = cv.getContext('2d');
    if (!cv._img || cv._img.width !== cv.width || cv._img.height !== cv.height)
      cv._img = g.createImageData(cv.width, cv.height);
    var ax = axisTable(cv, cv.width, cv.height, xa, xb, ya, yb);
    paintField(cv._img, cv.width, cv.height, ax, fA, fB, t, climA, climB, nb);
    g.putImageData(cv._img, 0, 0);
    return cv;
  }

  /* Reading four custom properties means a style resolve; during an animation
     that is per frame for a value that only changes when the palette is toggled.
     Cached against the mode attribute, which is what actually swaps it. */
  var paintCache = null, barCache = {};
  function palette() {
    var mode = document.documentElement.dataset.mode || '';
    if (paintCache && paintCache.mode === mode) return paintCache;
    var cs = getComputedStyle(document.documentElement);
    var get = function (n, f) { return (cs.getPropertyValue(n) || '').trim() || f; };
    paintCache = {
      mode:  mode,
      text:  get('--text', '#14324B'),
      muted: get('--muted', '#4A5F73'),
      line:  get('--line', '#DFD6BC'),
      surf:  get('--surface', '#FFFDF6')
    };
    return paintCache;
  }

  var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  /* ======================================================================
     THE PORTHOLE — the bubble's picture
     ====================================================================== */
  var thumb    = document.getElementById('piv-thumb');
  var thumbTag = document.getElementById('piv-thumb-tag');
  var tctx     = thumb.getContext('2d');
  var tScratch = null, tW = 0, tH = 0;
  var tFrom = 0, tTo = 0, tStart = 0, tCycling = false, tVisible = true, tPaused = false;

  /* The four frames the porthole cycles through. Both components at the heated
     condition, then both difference fields. */
  var FRAMES = [
    { v: 'U', c: 'on'   },
    { v: 'V', c: 'on'   },
    { v: 'U', c: 'diff' },
    { v: 'V', c: 'diff' }
  ];

  /* Crop window into the measurement domain. Recomputed whenever the porthole
     changes shape so the field always COVERS it — filling the pill edge to edge
     with no letterboxed bands at the top and bottom. */
  var TXA = XMIN, TXB = XMAX, TYA = YMIN, TYB = YMAX;

  /* The porthole crops to the MEASURED GRID, not to the plot axes. The axes
     window is padded out past the last vector and runs below the wall, and
     those margins have no data in them — as a picture they read as flat blank
     bands across the top and bottom. The full figure in the dialog still uses
     the real axes, because there the padding is correct. */
  var GXA = X0, GXB = X0 + (NX - 1) * DX;
  var GYA = 0, GYB = Y0 + (NY - 1) * DY;      // from the wall up, never below it

  /* Framing for the porthole, in millimetres, picked off the full figure. It
     deliberately sits inside the measured field: clear of the two roughness
     elements at the wall, where the vectors are rejected and render as bare
     patches (x ~ 0-25 and x ~ 141-160), clear of the ragged left edge, and below
     the sparse top corner. The full figure in the dialog is unaffected. */
  var PVX0 = 30, PVX1 = 136, PVY0 = 0, PVY1 = 78;

  /* Cropping to the grid is still not enough: the outer rows and columns are
     themselves all-rejected — the CHC < 1 quality rule throws out vectors at
     the wall and at the edges of the interrogation window — so they paint as
     flat blank bands. Measure where valid data actually exists, across every
     frame the porthole shows, and crop to that instead. */
  function validBounds() {
    var seen = {}, arrs = [];
    FRAMES.forEach(function (f) {
      var k = f.c + '.' + f.v;
      if (!seen[k]) { seen[k] = 1; if (F[k]) arrs.push(F[k]); }
    });
    if (!arrs.length) return;

    /* A bbox of "any valid point" is not enough — a row holding two stray
       vectors still paints as a blank band. Keep the rows and columns that are
       at least half covered. */
    var rowHit = new Array(NY).fill(0), colHit = new Array(NX).fill(0);
    for (var j = 0; j < NY; j++) {
      for (var i = 0; i < NX; i++) {
        var k = j * NX + i, ok = true;
        for (var n = 0; n < arrs.length; n++) {
          var v = arrs[n][k];
          if (v !== v) { ok = false; break; }           // NaN = rejected
        }
        if (ok) { rowHit[j]++; colHit[i]++; }
      }
    }
    function span(hit, total) {
      var a = -1, b = -1;
      for (var q = 0; q < hit.length; q++)
        if (hit[q] / total >= 0.5) { if (a < 0) a = q; b = q; }
      return [a, b];
    }
    var js = span(rowHit, NX), is = span(colHit, NY);
    var j0 = js[0], j1 = js[1], i0 = is[0], i1 = is[1];
    if (j0 < 0 || i0 < 0 || j1 - j0 < 4 || i1 - i0 < 4) return;   // keep the grid box

    /* One cell further in: bilinear sampling needs four valid corners, so the
       outermost valid cell still renders blank along its outer side. */
    i0 += 1; i1 -= 1; j0 += 1; j1 -= 1;
    GXA = X0 + i0 * DX; GXB = X0 + i1 * DX;
    GYA = Y0 + j0 * DY; GYB = Y0 + j1 * DY;

    /* Intersect with the chosen framing. Taking the overlap rather than the
       framing outright means the porthole can never reach past real data, even
       if a different run is dropped in later. */
    GXA = Math.max(GXA, PVX0); GXB = Math.min(GXB, PVX1);
    GYA = Math.max(GYA, PVY0); GYB = Math.min(GYB, PVY1);
  }

  function thumbWindow() {
    var dw = GXB - GXA, dh = GYB - GYA;
    var slot = tH / tW;                                 // wanted height : width
    if (slot <= dh / dw) {
      /* porthole is wider than the grid: keep all of x, trim y from the top —
         the roughness elements and the heated element sit at y ~ 0, so trimming
         symmetrically would crop away the entire point of the figure. */
      TXA = GXA; TXB = GXB;
      TYA = GYA; TYB = GYA + dw * slot;
    } else {                                            // trim x, keep all of y
      var nw = dh / slot, cx = (GXA + GXB) / 2;
      TXA = cx - nw / 2; TXB = cx + nw / 2;
      TYA = GYA; TYB = GYB;
    }
  }

  function thumbSize() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(pic.clientWidth * dpr), h = Math.round(pic.clientHeight * dpr);
    if (w < 8 || h < 8) { w = 300; h = 214; }           // laid out yet?
    if (w > 460) { h = Math.round(h * 460 / w); w = 460; }   // decorative: cap the cost
    if (w !== tW || h !== tH) {
      tW = w; tH = h;
      thumb.width = w; thumb.height = h;
      tScratch = scratch(w, h);
      thumbWindow();
    }
  }

  function drawThumb(t) {
    thumbSize();
    var A = FRAMES[tFrom], B = FRAMES[tTo];
    fieldToCanvas(tScratch, TXA, TXB, TYA, TYB,
                  F[A.c + '.' + A.v], F[B.c + '.' + B.v], t,
                  VARS[A.v].clim[A.c], VARS[B.v].clim[B.c], BANDS[B.c]);
    tctx.fillStyle = palette().line;
    tctx.fillRect(0, 0, tW, tH);
    tctx.drawImage(tScratch, 0, 0);
    var cur = t < 0.5 ? A : B;
    thumbTag.innerHTML = '<b>' + TITLE[cur.c] + '</b><i>PIV · ' + cur.v + '</i>';
    thumbTag.style.opacity = (t > 0.15 && t < 0.85) ? '0.25' : '1';
  }

  function cycle(now) {
    if (!tCycling) return;
    if (tPaused || !tVisible) { tStart = now; requestAnimationFrame(cycle); return; }
    var dt = now - tStart;
    if (dt < HOLD) { requestAnimationFrame(cycle); return; }
    var p = (dt - HOLD) / THUMB_MORPH;
    if (p >= 1) {
      tFrom = tTo; tTo = (tTo + 1) % FRAMES.length; tStart = now;
      drawThumb(0);
    } else {
      drawThumb(ease(p));
    }
    requestAnimationFrame(cycle);
  }

  function startThumb() {
    validBounds();
    tFrom = 0; tTo = reduce ? 0 : 1;
    tW = 0;                       // force thumbWindow() to pick up the new bounds
    drawThumb(0);
    if (reduce) return;
    tCycling = true;
    tStart = performance.now();
    requestAnimationFrame(cycle);
  }

  if (window.IntersectionObserver) {
    new IntersectionObserver(function (es) { tVisible = es[0].isIntersecting; },
                             { threshold: 0.05 }).observe(pic);
  }
  document.addEventListener('visibilitychange', function () { tVisible = !document.hidden; });
  window.addEventListener('resize', function () { if (tW) { tW = 0; drawThumb(0); } });

  /* ======================================================================
     THE FULL FIGURE
     ====================================================================== */
  var dlg   = document.getElementById('p-piv');
  var cv    = document.getElementById('piv-plot');
  var ctx   = cv.getContext('2d');
  var xyEl  = document.getElementById('piv-xy');
  var tabEl = document.getElementById('piv-tab');
  var flagEl= document.getElementById('piv-flagnote');
  var rows  = tabEl.tBodies[0].rows;

  var M = { l: 56, r: 18, t: 68, b: 46 };
  var cssW = 0, cssH = 0, pw = 0, ph = 0, dpr = 1;
  var baseCv = null, fieldCv = null, draftCv = null;
  var cur = { c: 'on', v: 'U' }, prev = { c: 'on', v: 'U' }, tMix = 1;
  var anim = null, hover = null, ready = false;

  var LENS_R = 64, LENS_MAG = 4.5;

  function layout() {
    var w = cv.parentNode.clientWidth;
    if (!w) return false;
    /* On a phone the axis gutters would eat most of the width, so they shrink;
       below that the figure has no usable plot area left and we bail rather than
       size a zero-width canvas. */
    var tight = w < 520;
    M.l = tight ? 40 : 56;  M.r = tight ? 10 : 18;
    M.t = tight ? 60 : 68;  M.b = tight ? 38 : 46;
    if (w - M.l - M.r < 120) return false;
    dpr  = Math.min(window.devicePixelRatio || 1, 2);
    cssW = w;
    pw   = cssW - M.l - M.r;
    ph   = Math.round(pw * ASPECT);
    cssH = ph + M.t + M.b;
    cv.width  = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width  = cssW + 'px';
    cv.style.height = cssH + 'px';
    var fw = Math.min(Math.round(pw * dpr), 1100);
    baseCv  = scratch(cv.width, cv.height);
    fieldCv = scratch(fw, Math.round(fw * ASPECT));
    /* Mid-morph every pixel costs two bilinear samples instead of one, so the
       transition is drawn at a third of the linear resolution and the settled
       frame is redrawn sharp.  Motion hides the softness; a still frame would not. */
    var dw = Math.max(160, Math.round(fw / 3));
    draftCv = scratch(dw, Math.round(dw * ASPECT));
    return true;
  }

  function climOf(s) { return VARS[s.v].clim[s.c]; }
  function fieldOf(s) { return F[s.c + '.' + s.v]; }

  /* base = field + axes + colour bar, cached so a mousemove only has to redraw
     the lens on top of it */
  function rebuild() {
    if (!baseCv) return;
    var g = baseCv.getContext('2d');
    var P = palette();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, baseCv.width, baseCv.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    var nb = BANDS[cur.c];
    var moving = tMix > 0 && tMix < 1;
    var target = moving ? draftCv : fieldCv;
    fieldToCanvas(target, XMIN, XMAX, YMIN, YMAX,
                  fieldOf(prev), fieldOf(cur), tMix, climOf(prev), climOf(cur), nb);

    g.fillStyle = P.line;                       // rejected vectors show through as this
    g.fillRect(M.l, M.t, pw, ph);
    g.imageSmoothingEnabled = moving;           // smooth the draft, keep bands crisp when settled
    g.drawImage(target, M.l, M.t, pw, ph);
    g.imageSmoothingEnabled = true;

    drawAxes(g, P, nb);
  }

  function lerpClim() {
    var a = climOf(prev), b = climOf(cur);
    return [a[0] + (b[0] - a[0]) * tMix, a[1] + (b[1] - a[1]) * tMix];
  }

  function drawAxes(g, P, nb) {
    var mono = '11px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
    var cl = lerpClim();

    /* colour bar, northoutside, the way the MATLAB figures place it.
       It only depends on the band count, so it is built once per band count
       rather than re-allocated on every animation frame. */
    var bx = M.l, by = M.t - 40, bw = Math.round(pw), bh = 14;
    var sc = barCache[nb + 'x' + bw];
    if (!sc) {
      sc = scratch(bw, 1);
      var sg = sc.getContext('2d'), strip = sg.createImageData(bw, 1), table = lut(nb);
      for (var i = 0; i < bw; i++) {
        var k = ((i + 0.5) / bw * nb | 0);
        if (k >= nb) k = nb - 1;
        k *= 3;
        strip.data[i * 4] = table[k]; strip.data[i * 4 + 1] = table[k + 1];
        strip.data[i * 4 + 2] = table[k + 2]; strip.data[i * 4 + 3] = 255;
      }
      sg.putImageData(strip, 0, 0);
      barCache[nb + 'x' + bw] = sc;
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(sc, bx, by, bw, bh);
    g.imageSmoothingEnabled = true;
    g.strokeStyle = P.text; g.lineWidth = 1; g.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);

    g.font = '600 ' + mono; g.fillStyle = P.text;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(VARS[cur.v].label, bx, by - 8);
    g.textAlign = 'right';
    g.fillText(TITLE[cur.c], bx + bw, by - 8);

    g.font = '500 ' + mono; g.fillStyle = P.muted; g.textBaseline = 'top';
    for (var f = 0; f <= 4; f++) {
      var vx = bx + f / 4 * bw, val = cl[0] + f / 4 * (cl[1] - cl[0]);
      g.textAlign = f === 0 ? 'left' : f === 4 ? 'right' : 'center';
      g.fillText(val.toFixed(2), vx, by + bh + 4);
    }

    /* plot frame, ticks, labels */
    var X = function (x) { return M.l + (x - XMIN) / (XMAX - XMIN) * pw; };
    var Y = function (y) { return M.t + (YMAX - y) / (YMAX - YMIN) * ph; };

    g.strokeStyle = P.text; g.lineWidth = 1;
    g.strokeRect(M.l + .5, M.t + .5, pw - 1, ph - 1);

    g.font = '500 ' + mono; g.fillStyle = P.muted;
    g.beginPath();
    for (var x = 0; x <= 210; x += 10) {                 // minor ticks, inward
      var px0 = Math.round(X(x)) + .5, len = (x % 50 === 0) ? 7 : 4;
      g.moveTo(px0, M.t + ph); g.lineTo(px0, M.t + ph - len);
      g.moveTo(px0, M.t);      g.lineTo(px0, M.t + len);
    }
    for (var y = 0; y <= 120; y += 10) {
      var py0 = Math.round(Y(y)) + .5, len2 = (y % 20 === 0) ? 7 : 4;
      g.moveTo(M.l, py0);      g.lineTo(M.l + len2, py0);
      g.moveTo(M.l + pw, py0); g.lineTo(M.l + pw - len2, py0);
    }
    g.strokeStyle = P.text; g.stroke();

    g.textAlign = 'center'; g.textBaseline = 'top';
    for (var xt = 0; xt <= 200; xt += 50) g.fillText(String(xt), X(xt), M.t + ph + 7);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (var yt = 0; yt <= 120; yt += 20) g.fillText(String(yt), M.l - 7, Y(yt));

    g.fillStyle = P.text; g.font = '600 12px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText('x (mm)', M.l + pw / 2, M.t + ph + 36);
    g.save();
    g.translate(14, M.t + ph / 2); g.rotate(-Math.PI / 2);
    g.textBaseline = 'top';
    g.fillText('y (mm)', 0, 0);
    g.restore();
  }

  /* lens: the same renderer over a much smaller data window */
  var lensCv = null;
  function paint() {
    if (!baseCv) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(baseCv, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!hover || anim) return;

    var side = Math.round(2 * LENS_R * dpr);
    if (!lensCv || lensCv.width !== side) lensCv = scratch(side, side);

    var spanX = (XMAX - XMIN) * (2 * LENS_R / pw) / LENS_MAG;
    var spanY = (YMAX - YMIN) * (2 * LENS_R / ph) / LENS_MAG;
    fieldToCanvas(lensCv, hover.x - spanX / 2, hover.x + spanX / 2,
                          hover.y - spanY / 2, hover.y + spanY / 2,
                  fieldOf(cur), fieldOf(cur), 1, climOf(cur), climOf(cur), BANDS[cur.c]);

    var P = palette();
    var mx = hover.px, my = hover.py;
    ctx.save();
    ctx.beginPath(); ctx.arc(mx, my, LENS_R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = P.line; ctx.fillRect(mx - LENS_R, my - LENS_R, 2 * LENS_R, 2 * LENS_R);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lensCv, mx - LENS_R, my - LENS_R, 2 * LENS_R, 2 * LENS_R);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx - 9, my); ctx.lineTo(mx + 9, my);
    ctx.moveTo(mx, my - 9); ctx.lineTo(mx, my + 9);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath(); ctx.arc(mx, my, LENS_R, 0, Math.PI * 2);
    ctx.lineWidth = 4; ctx.strokeStyle = P.surf; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = P.text; ctx.stroke();

    /* the label sits over whatever colour the field happens to be there, so it
       carries its own halo rather than trusting the background */
    var tag = LENS_MAG.toFixed(1).replace('.0', '') + '×';
    ctx.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5; ctx.strokeStyle = P.surf;
    ctx.strokeText(tag, mx, my + LENS_R + 6);
    ctx.fillStyle = P.text;
    ctx.fillText(tag, mx, my + LENS_R + 6);
  }

  /* ------------------------------------------------------------ the transition */
  function goTo(next) {
    if (next.c === cur.c && next.v === cur.v) return;
    if (anim) cancelAnimationFrame(anim);
    prev = { c: cur.c, v: cur.v };
    cur  = next;
    syncButtons();
    tabEl.dataset.col = COL[cur.c];
    if (reduce) { tMix = 1; rebuild(); paint(); anim = null; return; }
    var t0 = performance.now();
    (function step(now) {
      var p = Math.min(1, (now - t0) / MORPH);
      tMix = ease(p);
      rebuild(); paint();
      anim = p < 1 ? requestAnimationFrame(step) : null;
      if (!anim) { prev = { c: cur.c, v: cur.v }; tMix = 1; paint(); }
    })(t0);
  }

  /* ---------------------------------------------------------------- the readout */
  function fmt(v) {
    if (v === null || v === undefined || v !== v) return '—';
    var a = Math.abs(v);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1)   return v.toFixed(3);
    return v.toFixed(4);
  }

  /* coarseDiff marks a Δ that is a live subtraction rather than a stored value:
     the operands are half-precision, so its 4th decimal is noise and printing it
     would claim resolution the number does not have. */
  function setRow(r, vals, flagStress, coarseDiff) {
    for (var c = 0; c < 3; c++) {
      var cell = r.cells[c + 1], v = vals[c];
      cell.textContent = (coarseDiff && c === 2 && v === v && v !== null)
                       ? v.toFixed(3) : fmt(v);
      var bad = flagStress && v === v && v !== null && Math.abs(v) > 1;
      cell.className = bad ? 'piv-warn' : '';
      if (bad) cell.textContent = '▲ ' + cell.textContent;
    }
  }

  function clearReadout() {
    xyEl.innerHTML = '<span>move over the plot</span>';
    for (var i = 0; i < rows.length; i++)
      for (var c = 1; c <= 3; c++) { rows[i].cells[c].textContent = '—'; rows[i].cells[c].className = ''; }
    flagEl.hidden = true;
  }

  function updateReadout(x, y) {
    var n = nodeAt(x, y);
    if (!n) { clearReadout(); return; }
    var on = {}, off = {}, dif = {}, any = false, flagged = false;
    QUANTS.forEach(function (q) {
      on[q]  = F['on.' + q][n.k];
      off[q] = F['off.' + q][n.k];
      dif[q] = F['diff.' + q][n.k];
      if (on[q] === on[q]) any = true;
    });
    xyEl.innerHTML = 'x = <b>' + n.x.toFixed(2) + '</b> mm &nbsp; y = <b>' + n.y.toFixed(2) + '</b> mm' +
                     (any ? '' : '<br><span>no valid data — vector rejected by the quality check</span>');

    var spd = function (s) { return Math.sqrt(s.U * s.U + s.V * s.V); };
    var q3 = function (k) { return [on[k], off[k], dif[k]]; };

    setRow(rows[0], q3('U'), false);
    setRow(rows[1], q3('V'), false);
    /* speed has no stored difference, so this one column really is a subtraction */
    setRow(rows[2], [spd(on), spd(off), spd(on) - spd(off)], false, true);
    setRow(rows[3], q3('uu'), true);
    setRow(rows[4], q3('uv'), true);
    setRow(rows[5], q3('vv'), true);
    setRow(rows[6], [0.5 * (on.uu + on.vv), 0.5 * (off.uu + off.vv),
                     0.5 * (dif.uu + dif.vv)], true);

    for (var i = 3; i < 7 && !flagged; i++)
      for (var c = 1; c <= 3; c++) if (rows[i].cells[c].className === 'piv-warn') flagged = true;
    flagEl.hidden = !flagged;
  }

  /* -------------------------------------------------------------------- events */
  function locate(e) {
    var r = cv.getBoundingClientRect();
    if (!r.width || !r.height || !pw || !ph) return null;   // hidden or not laid out yet
    var px = (e.clientX - r.left) * (cssW / r.width);
    var py = (e.clientY - r.top)  * (cssH / r.height);
    if (!isFinite(px) || !isFinite(py)) return null;
    if (px < M.l || px > M.l + pw || py < M.t || py > M.t + ph) return null;
    return {
      px: px, py: py,
      x: XMIN + (px - M.l) / pw * (XMAX - XMIN),
      y: YMAX - (py - M.t) / ph * (YMAX - YMIN)
    };
  }

  cv.addEventListener('pointermove', function (e) {
    if (!ready) return;
    hover = locate(e);
    if (hover) updateReadout(hover.x, hover.y); else clearReadout();
    paint();
  });
  cv.addEventListener('pointerleave', function () { hover = null; clearReadout(); paint(); });

  var segCase = document.getElementById('piv-case');
  var segVar  = document.getElementById('piv-var');

  function syncButtons() {
    [[segCase, 'case', cur.c], [segVar, 'var', cur.v]].forEach(function (s) {
      var seg = s[0], key = s[1], val = s[2], active = null;
      seg.querySelectorAll('button').forEach(function (b) {
        var on = b.dataset[key] === val;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) active = b;
      });
      if (active) {
        var pill = seg.querySelector('.pill');
        pill.style.width = active.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      }
    });
  }

  segCase.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (b) goTo({ c: b.dataset.case, v: cur.v });
  });
  segVar.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (b) goTo({ c: cur.c, v: b.dataset.var });
  });

  function openViewer() {
    if (!dlg || dlg.open) return;      // showModal() on an open dialog throws
    tPaused = true;
    dlg.showModal();
    if (layout()) { rebuild(); paint(); syncButtons(); }
  }

  pic.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();          // must not toggle the bubble
    if (ready) openViewer();
  });
  pic.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (ready) openViewer(); }
  });
  dlg.addEventListener('close', function () { tPaused = false; tStart = performance.now(); });

  var rt = null;
  window.addEventListener('resize', function () {
    if (!dlg.open) return;
    clearTimeout(rt);
    rt = setTimeout(function () { if (layout()) { rebuild(); paint(); syncButtons(); } }, 120);
  });

  /* ------------------------------------------------------------------- kick off */
  loadAll().then(function () {
    ready = true;
    cv.dataset.ready = '1';
    startThumb();
    if (dlg.open && layout()) { rebuild(); paint(); syncButtons(); }
  }).catch(function (err) {
    pic.dataset.failed = '1';
    var boot = document.querySelector('.piv-boot');
    if (boot) boot.textContent = 'could not load the flow-field data (' + err.message + ')';
    if (window.console) console.error('PIV viewer:', err);
  });
})();
