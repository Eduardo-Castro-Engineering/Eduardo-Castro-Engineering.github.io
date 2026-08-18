/**
 * <chroma-video> — plays a greenscreen video with the key colour removed on a
 * WebGL canvas, so it can sit behind page content. Decorative: no controls,
 * no audio, pointer-events off.
 *
 * Attributes
 *   src            video URL (required)
 *   key-color      key colour as "r,g,b" 0-255            (default "29,130,66")
 *   similarity     chroma distance treated as pure key     (default .085)
 *   smoothness     soft edge width beyond similarity       (default .085)
 *   spill          green-spill suppression strength        (default 3)
 *   rate           playbackRate multiplier                 (default 1)
 *   loop           present = loop while in view; absent = play once per entry
 *   threshold      IntersectionObserver ratio to start     (default .3)
 *   fit            object-fit for the canvas              (default "contain")
 *   max-width      render buffer cap in px                 (default 1280)
 *
 * Honours prefers-reduced-motion by staying blank.
 */
(() => {
  if (customElements.get('chroma-video')) return;

  const VS = `attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}`;
  const FS = `precision mediump float;
varying vec2 uv;uniform sampler2D tex;uniform vec3 keyRGB;uniform float sim,smth,spill;
vec2 chroma(vec3 c){float y=dot(c,vec3(.299,.587,.114));return vec2(.5*(c.b-y)/.886,.5*(c.r-y)/.701);}
void main(){
  vec4 t=texture2D(tex,uv);
  float d=distance(chroma(t.rgb),chroma(keyRGB));
  float a=smoothstep(sim,sim+smth,d);
  float g=t.g-max(t.r,t.b);
  vec3 col=t.rgb;
  if(g>0.){float k=clamp(g*spill,0.,1.);col=mix(col,vec3(dot(col,vec3(.3333))),k);}
  gl_FragColor=vec4(col*a,a);
}`;

  const sh = (gl, type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };

  class ChromaVideo extends HTMLElement {
    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.style.display = 'block';
      this.style.pointerEvents = 'none';

      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

      const cv = document.createElement('canvas');
      cv.style.cssText = `display:block;width:100%;height:100%;object-fit:${this.getAttribute('fit') || 'contain'}`;
      this.appendChild(cv);

      const v = document.createElement('video');
      v.muted = true; v.defaultMuted = true; v.volume = 0;
      v.playsInline = true; v.preload = 'metadata';
      v.setAttribute('aria-hidden', 'true');
      if (this.hasAttribute('loop')) v.loop = true;
      const rate = parseFloat(this.getAttribute('rate'));
      if (rate > 0) { v.playbackRate = rate; v.defaultPlaybackRate = rate; }
      v.src = this.getAttribute('src');
      v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
      this.appendChild(v);
      this._video = v;

      const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) return;

      let prog;
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      } catch (e) { console.warn('chroma-video:', e.message); return; }
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const key = (this.getAttribute('key-color') || '29,130,66').split(',').map(Number);
      gl.uniform3f(gl.getUniformLocation(prog, 'keyRGB'), key[0] / 255, key[1] / 255, key[2] / 255);
      gl.uniform1f(gl.getUniformLocation(prog, 'sim'), parseFloat(this.getAttribute('similarity')) || 0.085);
      gl.uniform1f(gl.getUniformLocation(prog, 'smth'), parseFloat(this.getAttribute('smoothness')) || 0.085);
      gl.uniform1f(gl.getUniformLocation(prog, 'spill'), parseFloat(this.getAttribute('spill')) || 3);
      gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
      gl.clearColor(0, 0, 0, 0);

      let sized = false, running = false;
      const cap = parseFloat(this.getAttribute('max-width')) || 1280;

      const draw = () => {
        if (v.readyState < 2) return;
        if (!sized) {
          const s = Math.min(1, cap / v.videoWidth);
          cv.width = Math.round(v.videoWidth * s);
          cv.height = Math.round(v.videoHeight * s);
          gl.viewport(0, 0, cv.width, cv.height);
          sized = true;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      const schedule = (fn) => v.requestVideoFrameCallback
        ? v.requestVideoFrameCallback(() => fn())
        : requestAnimationFrame(() => fn());
      const loop = () => {
        if (!running) return;
        draw();
        if (v.paused || v.ended) { running = false; return; }
        schedule(loop);
      };
      const start = () => { if (!running) { running = true; loop(); } };
      const clear = () => { if (sized) gl.clear(gl.COLOR_BUFFER_BIT); };
      this._gl = gl; this._canvas = cv; this._draw = draw;

      v.addEventListener('play', start);
      v.addEventListener('playing', start);
      v.addEventListener('loadeddata', draw);
      v.addEventListener('seeked', draw);
      v.addEventListener('ended', () => { running = false; clear(); });

      if (reduce) return;

      let playing = false;
      const io = new IntersectionObserver((es) => {
        const e = es[0];
        if (e.isIntersecting) {
          if (!playing) {
            playing = true;
            try { v.currentTime = 0; } catch (_) {}
            const p = v.play();
            if (p && p.catch) p.catch((err) => { this._err = err && err.name; });
          }
        } else {
          playing = false;
          running = false;
          v.pause();
          clear();
        }
      }, { threshold: parseFloat(this.getAttribute('threshold')) || 0.3 });
      io.observe(this);
      this._io = io;

      // Fallback for hosts where the scrolling ancestor is not the viewport:
      // any scroll anywhere re-tests the element's own rect.
      const check = () => {
        const r = this.getBoundingClientRect();
        const vis = r.bottom > 0 && r.top < innerHeight * 0.92 && r.height > 0;
        if (vis && !playing) {
          playing = true;
          try { v.currentTime = 0; } catch (_) {}
          const p = v.play();
          if (p && p.catch) p.catch((err) => { this._err = err && err.name; });
        } else if (!vis && playing) {
          playing = false; running = false; v.pause(); clear();
        }
      };
      this._check = check;
      document.addEventListener('scroll', check, { capture: true, passive: true });
      addEventListener('resize', check, { passive: true });
      this._offScroll = () => {
        document.removeEventListener('scroll', check, { capture: true });
        removeEventListener('resize', check);
      };
    }

    disconnectedCallback() {
      if (this._io) this._io.disconnect();
      if (this._offScroll) this._offScroll();
      if (this._video) { this._video.pause(); this._video.removeAttribute('src'); }
    }
  }

  customElements.define('chroma-video', ChromaVideo);
})();
