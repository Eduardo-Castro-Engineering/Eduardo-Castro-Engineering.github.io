/* ============================================================================
   (2092) SUMIANA LIGHTCURVE VIEWER
   Renders the asteroid photometry that ships in lightcurve-data.js. Two
   surfaces:

     · the porthole — the astronomy bubble's picture. It replays the period
                      search on loop: the trial period sweeps away from the
                      answer (the ten nights smear into noise) and settles
                      back onto it (they stack into one curve), flashing a
                      green "correct!" on every landing.
     · the figure   — inside <dialog id="p-lc">, opened by clicking the
                      porthole (as with the PIV figure): the same folded plot
                      with the spreadsheet's spin-button controls — nudge the
                      trial period and watch the nights align. Landing on the
                      published period lights the figure green.

   The fold is the one the spreadsheet uses, verbatim:
       P     = 1.27 + index / 10000            (days; one click = ±2 = 0.0002 d)
       phase = (t − P·floor(t/P)) / P          (t = JD − JD0 − light-travel time)
   The Apr14-T19 series plots 4-point boxcar means of the folded values, as in
   the spreadsheet. Session colours, marker shapes and axis window are lifted
   from the Excel composite chart so this agrees with the published figure.
   ============================================================================ */
(function () {
  'use strict';

  var D   = window.SUMIANA;
  var pic = document.getElementById('lc-pic');
  if (!pic) return;

  var thumb = document.getElementById('lc-thumb');
  var panel = document.getElementById('lc-panel');
  if (!D || !thumb || !thumb.getContext) {
    pic.dataset.failed = '1';                    // porthole falls back to the M33 photo
    if (panel) panel.hidden = true;
    return;
  }

  /* ---------------------------------------------------------------- constants */
  var BASE = D.periodBase, DIV = D.indexDiv;     // P(days) = BASE + idx / DIV
  var BEST = D.bestIndex;                        // 22  → 1.2722 d = 30.5328 h
  var STEP = D.indexStep;                        // one spreadsheet click = 2
  var IMIN = 0, IMAX = 10000;                    // the spreadsheet spinner's range
  var YMIN = D.yMin, YMAX = D.yMax;              // 12 … 13.2, brighter at the top

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var GREEN = '#2E9E5B';

  function periodOf(idx) { return BASE + idx / DIV; }
  function hoursOf(idx)  { return periodOf(idx) * 24; }

  /* The one line of physics: fold a time (days past the epoch, light-travel
     corrected) at trial period P. floor() matches the spreadsheet's INT(). */
  function phaseOf(t, P) { return (t - P * Math.floor(t / P)) / P; }

  /* Screen-space phase+mag pairs for every session at trial period P.
     Sessions with bin=N plot boxcar means of N folded values — averaging the
     already-folded hours exactly as the spreadsheet does, wrap artefacts
     included, so the web figure and the Excel figure never disagree. */
  function foldAll(P) {
    var out = [];
    for (var s = 0; s < D.sessions.length; s++) {
      var ses = D.sessions[s], pts = ses.points, f = [];
      if (ses.bin) {
        for (var i = 0; i + ses.bin <= pts.length; i += ses.bin) {
          var hSum = 0, mSum = 0;
          for (var j = 0; j < ses.bin; j++) {
            hSum += phaseOf(pts[i + j][0], P) * P * 24;
            mSum += pts[i + j][1];
          }
          f.push([hSum / ses.bin / (P * 24), mSum / ses.bin]);
        }
      } else {
        for (var k = 0; k < pts.length; k++) f.push([phaseOf(pts[k][0], P), pts[k][1]]);
      }
      out.push(f);
    }
    return out;
  }

  /* ------------------------------------------------------------------ drawing */
  function css(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function drawMarker(ctx, sym, x, y, r) {
    ctx.beginPath();
    if (sym === 'circle') {
      ctx.arc(x, y, r, 0, 6.2832);
    } else if (sym === 'square') {
      ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    } else if (sym === 'diamond') {
      ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.3, y);
      ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.3, y);
      ctx.closePath();
    } else if (sym === 'triangle') {
      ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.15, y + r * 0.95);
      ctx.lineTo(x - r * 1.15, y + r * 0.95);
      ctx.closePath();
    } else {                                     // 'dash' — the survey points
      ctx.rect(x - r * 1.4, y - Math.max(0.7, r * 0.3), r * 2.8, Math.max(1.4, r * 0.6));
    }
  }

  /* Scatter into a rectangle. Returns screen coords when collect is true so the
     panel can hover-identify points. */
  function drawPoints(ctx, folded, box, rScale, collect) {
    var hits = collect ? [] : null;
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    for (var s = 0; s < D.sessions.length; s++) {
      var ses = D.sessions[s], f = folded[s];
      var r = ses.size * rScale;
      ctx.fillStyle = ses.color;
      var stroke = ses.edge && ses.edge !== ses.color;
      if (stroke) { ctx.strokeStyle = ses.edge; ctx.lineWidth = Math.max(1, rScale * 1.1); }
      for (var i = 0; i < f.length; i++) {
        var mag = f[i][1];
        if (mag < box.magTop || mag > box.magBot) continue;   // off the axis, as in Excel
        var x = box.x + f[i][0] * box.w;
        var y = box.y + (mag - box.magTop) / (box.magBot - box.magTop) * box.h;
        drawMarker(ctx, ses.symbol, x, y, r);
        ctx.fill();
        if (stroke) ctx.stroke();
        if (hits) hits.push([x, y, s, f[i][0], mag]);
      }
    }
    ctx.restore();
    return hits;
  }

  /* ======================================================================
     THE PORTHOLE
     ====================================================================== */
  var tctx = thumb.getContext('2d');
  var glowEl = document.getElementById('lc-glow');
  var tW = 0, tH = 0, tVisible = true, tPaused = false, tStart = performance.now();
  var SWEEP = 4600, HOLD = 1800;                 // ms — one landing per loop
  var wasHit = null;

  function thumbSize() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(pic.clientWidth * dpr), h = Math.round(pic.clientHeight * dpr);
    if (w < 8 || h < 8) { w = 300; h = 214; }
    if (w > 900) { h = Math.round(h * 900 / w); w = 900; }   // decorative: cap the cost
    if (w !== tW || h !== tH) { tW = w; tH = h; thumb.width = w; thumb.height = h; }
  }

  /* One positive-going hump with a wobble riding on it: the trial period
     climbs away, hunts around, and glides back to a dead stop on the answer.
     Never dips below the answer mid-loop, so the points visibly align exactly
     once per cycle — at the landing. */
  function sweepIndex(u) {
    var hump = Math.sin(Math.PI * u); hump *= hump;
    return BEST + 440 * hump * (1 - 0.22 * Math.sin(6 * Math.PI * u));
  }

  function drawThumb(idx, hit) {
    thumbSize();
    var dpr = tW / Math.max(1, pic.clientWidth || 300);
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = tW / dpr, h = tH / dpr;
    tctx.fillStyle = css('--surface', '#FFFDF6');
    tctx.fillRect(0, 0, w, h);

    /* Phase 0–1 spans the full pill, with slight overdraw past both rounded
       ends so no blank surface shows at the sides — the stadium edge crops the
       extremes. The magnitude axis zooms on the curve itself (12.25–13.05; the
       survey points clip like they do on the published figure's 12–13.2 window). */
    var box = { x: -w * 0.02, y: h * 0.16, w: w * 1.04, h: h * 0.70, magTop: 12.25, magBot: 13.05 };
    drawPoints(tctx, foldAll(periodOf(idx)), box, Math.max(0.34, w / 560), false);

    tctx.font = '700 ' + Math.max(11, w / 26) + 'px ' + css('--mono', 'monospace');
    tctx.textAlign = 'center'; tctx.textBaseline = 'top';   // centred: the stadium's
    tctx.fillStyle = hit ? GREEN : css('--muted', '#4A5F73'); // corners clip the edges
    tctx.fillText('P = ' + hoursOf(idx).toFixed(hit ? 4 : 2) + ' h', w / 2, h * 0.05);

    if (hit !== wasHit) {                        // CSS runs the glow + "correct!"
      wasHit = hit;
      if (hit) pic.dataset.hit = '1'; else delete pic.dataset.hit;
    }
  }

  function cycle(now) {
    if (tPaused || !tVisible || document.hidden) { tStart = now; requestAnimationFrame(cycle); return; }
    var dt = (now - tStart) % (SWEEP + HOLD);
    if (dt < SWEEP) drawThumb(sweepIndex(dt / SWEEP), false);
    else            drawThumb(BEST, true);
    requestAnimationFrame(cycle);
  }

  if (reduce) {
    drawThumb(BEST, true);                       // no motion: rest on the answer, lit
    window.addEventListener('resize', function () { tW = 0; drawThumb(BEST, true); });
  } else {
    requestAnimationFrame(cycle);
    window.addEventListener('resize', function () { tW = 0; });
  }
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (es) { tVisible = es[0].isIntersecting; },
                             { threshold: 0.05 }).observe(pic);
  }

  /* ======================================================================
     THE PANEL — the spreadsheet's spin buttons, live
     ====================================================================== */
  if (!panel) return;
  var plot   = document.getElementById('lc-plot');
  var pctx   = plot.getContext('2d');
  var readH  = document.getElementById('lc-read-h');
  var readD  = document.getElementById('lc-read-d');
  var tip    = document.getElementById('lc-tip');
  var fig    = plot.parentElement;

  var idx = BEST;                                // the sheet ships on the answer
  var hitPts = [];

  function setHit(on) {
    if (on) panel.dataset.hit = '1'; else delete panel.dataset.hit;
  }

  function drawPlot() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);   // 3x+ buys nothing visible here
    var cw = plot.clientWidth, ch = plot.clientHeight;
    if (!cw || !ch) return;                      // dialog still closed
    if (plot.width !== Math.round(cw * dpr)) { plot.width = Math.round(cw * dpr); plot.height = Math.round(ch * dpr); }
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var ink = css('--text', '#14324B'), mut = css('--muted', '#4A5F73');
    var line = css('--line', '#DFD6BC'), surf = css('--surface', '#FFFDF6');
    var mono = css('--mono', 'monospace');
    pctx.fillStyle = surf; pctx.fillRect(0, 0, cw, ch);

    var small = cw < 520;
    var M = { l: small ? 40 : 52, r: small ? 10 : 16, t: 12, b: small ? 34 : 40 };
    var box = { x: M.l, y: M.t, w: cw - M.l - M.r, h: ch - M.t - M.b, magTop: YMIN, magBot: YMAX };

    /* grid + ticks: recessive, labels in ink */
    pctx.strokeStyle = line; pctx.lineWidth = 1; pctx.globalAlpha = 0.55;
    pctx.font = '600 ' + (small ? 10 : 11.5) + 'px ' + mono;
    pctx.textAlign = 'center'; pctx.textBaseline = 'top'; pctx.fillStyle = mut;
    var i, x, y;
    for (i = 0; i <= 10; i++) {                  // phase 0 … 1 every 0.1
      x = box.x + box.w * i / 10;
      pctx.beginPath(); pctx.moveTo(x, box.y); pctx.lineTo(x, box.y + box.h); pctx.stroke();
      var lab = i === 0 ? '0' : i === 10 ? '1' : (i / 10).toFixed(1);   // as on the figure
      if (i % 2 === 0 || !small) pctx.fillText(lab, x, box.y + box.h + 6);
    }
    pctx.textAlign = 'right'; pctx.textBaseline = 'middle';
    for (i = 0; i <= 6; i++) {                   // mag 12 … 13.2 every 0.2, bright side up
      var mag = YMIN + (YMAX - YMIN) * i / 6;
      y = box.y + box.h * i / 6;
      pctx.beginPath(); pctx.moveTo(box.x, y); pctx.lineTo(box.x + box.w, y); pctx.stroke();
      pctx.fillText(mag.toFixed(1), box.x - 7, y);
    }
    pctx.globalAlpha = 1;
    pctx.strokeStyle = mut; pctx.lineWidth = 1.5;
    pctx.strokeRect(box.x, box.y, box.w, box.h);

    /* axis titles + the figure's own title, as on the published plot */
    pctx.fillStyle = ink;
    pctx.font = '700 ' + (small ? 11 : 12.5) + 'px ' + mono;
    pctx.textAlign = 'center'; pctx.textBaseline = 'bottom';
    pctx.fillText('Phase', box.x + box.w / 2, ch - (small ? 4 : 6));
    pctx.save();
    pctx.translate(small ? 11 : 13, box.y + box.h / 2); pctx.rotate(-Math.PI / 2);
    pctx.fillText('Relative magnitude', 0, 0);
    pctx.restore();
    pctx.font = '700 ' + (small ? 13 : 16) + 'px ' + mono;
    pctx.textAlign = 'left'; pctx.textBaseline = 'top';
    pctx.fillText('(2092) Sumiana', box.x + 10, box.y + 8);

    hitPts = drawPoints(pctx, foldAll(periodOf(idx)), box, small ? 0.6 : 0.78, true);
  }

  function update() {
    readH.textContent = hoursOf(idx).toFixed(4) + ' h';
    readD.textContent = periodOf(idx).toFixed(5) + ' d';
    setHit(idx === BEST);
    drawPlot();
  }

  /* -------------------------------------------------- the spin buttons */
  function nudge(dir, big) {
    idx = Math.min(IMAX, Math.max(IMIN, idx + dir * STEP * (big ? 5 : 1)));
    hideTip(); update();
  }

  function armSpin(btn, dir) {
    var timer = null, held = 0;
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault(); btn.setPointerCapture(e.pointerId);
      held = 0; nudge(dir);
      timer = setInterval(function () { held++; nudge(dir, held > 12); }, 95);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      btn.addEventListener(ev, stop);
    });
    btn.addEventListener('click', function (e) {  // keyboard "clicks" arrive with detail 0
      if (e.detail === 0) nudge(dir);
    });
  }
  armSpin(document.getElementById('lc-up'),   +1);
  armSpin(document.getElementById('lc-down'), -1);

  document.getElementById('lc-scramble').addEventListener('click', function () {
    var off = (160 + Math.floor(Math.random() * 200) * 2) * (Math.random() < 0.5 ? -1 : 1);
    idx = Math.min(IMAX, Math.max(IMIN, BEST + off));
    hideTip(); update();
  });

  /* scrolling on the figure tunes the period too — one notch, one click */
  fig.addEventListener('wheel', function (e) {
    e.preventDefault();
    nudge(e.deltaY < 0 ? +1 : -1, e.shiftKey);
  }, { passive: false });

  /* -------------------------------------------------- hover identification */
  function hideTip() { tip.hidden = true; }
  plot.addEventListener('pointermove', function (e) {
    var r = plot.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var best = null, bd = 14 * 14;
    for (var i = 0; i < hitPts.length; i++) {
      var dx = hitPts[i][0] - mx, dy = hitPts[i][1] - my, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = hitPts[i]; }
    }
    if (!best) { hideTip(); return; }
    var ses = D.sessions[best[2]];
    tip.innerHTML = '<b>' + ses.name + '</b>phase ' + best[3].toFixed(3) +
                    ' · mag ' + best[4].toFixed(2);
    tip.hidden = false;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(plot.clientWidth - tw - 4, best[0] + 14)) + 'px';
    tip.style.top  = Math.max(4, best[1] - th - 12) + 'px';
  });
  plot.addEventListener('pointerleave', hideTip);

  /* -------------------------------------------------- legend, built from data */
  var leg = document.getElementById('lc-legend');
  if (leg) {
    D.sessions.forEach(function (ses) {
      var chip = document.createElement('span');
      chip.className = 'lc-chip';
      var edge = (ses.edge && ses.edge !== ses.color)
        ? ' stroke="' + ses.edge + '" stroke-width="1.4"' : '';
      var g = '';
      if (ses.symbol === 'circle')        g = '<circle cx="7" cy="7" r="4.4"';
      else if (ses.symbol === 'square')   g = '<rect x="3" y="3" width="8" height="8"';
      else if (ses.symbol === 'diamond')  g = '<path d="M7 1.4 12.6 7 7 12.6 1.4 7Z"';
      else if (ses.symbol === 'triangle') g = '<path d="M7 1.8 12.8 12 1.2 12Z"';
      else                                g = '<rect x="2" y="5.6" width="10" height="2.8" rx="1.3"';
      chip.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">' +
                       g + ' fill="' + ses.color + '"' + edge + '/></svg>' + ses.name;
      leg.appendChild(chip);
    });
  }

  /* -------------------------------------------------- sizing + first paint */
  if (window.ResizeObserver) new ResizeObserver(function () { drawPlot(); }).observe(fig);

  /* The porthole is the way in, as with the PIV figure: clicking it opens the
     dialog instead of toggling the bubble. */
  var dlg = document.getElementById('p-lc');
  /* The dialog covers the porthole completely, so its sweep pauses while open —
     same arrangement as the PIV porthole. */
  function openViewer() { if (dlg && !dlg.open) { tPaused = true; dlg.showModal(); update(); } }
  if (dlg) dlg.addEventListener('close', function () { tPaused = false; });
  pic.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation(); openViewer();
  });
  pic.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openViewer(); }
  });
  document.querySelectorAll('.switch button').forEach(function (b) {
    b.addEventListener('click', function () { tW = 0; update(); });   // repaint on palette swap
  });
  update();
})();
