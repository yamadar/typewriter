/*
 * script.js — view / IO layer for the typewriter.
 *
 * Typing logic lives in the model (typewriter-model.js, unit-tested). This file builds
 * the keyboard from LAYOUT, wires input, renders the paper + mechanism, and plays audio.
 *
 * Carriage model (like a real machine): the print point is FIXED. The whole carriage —
 * [CR lever][paper][paper-release lever] — slides left as you type, back on CR, and the
 * paper feeds up on LF. The type basket (folding-fan) is fixed below the print point.
 *  - Single SHIFT picks the upper glyph for all keys; SHIFT LOCK latches it for all
 *    (and lights the Shift keys). CR/LF are separate.
 *  - CR lever: pull right = CR, pull toward you (down) = LF, click = CR+LF.
 */
(() => {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;

  const tw = createTypewriter();
  const COLS = tw.cols;
  const codes = new Set(LAYOUT.rows.flat().map((k) => k.code));

  // ---- paper geometry (the paper is a wide sheet drawn at 1 CSS px = 1 unit) ----
  const FS = 17, ROWH = Math.round(FS * 1.5), GAP = 8, VIS_ROWS = 10, PLATEN_H = 10;
  const FONT = `${FS}px "Courier Prime","Courier New",monospace`;
  // equal margins on both sides of the text; the print point stays at the deck centre
  let charW = FS * 0.6, padL = 48, padR = 48, pageW = 0, pageH = 0, printLineY = 0, platenTopY = 0;

  // ---- render state ----
  const stamps = [];                 // {row,col,ch,jx,jy,a,rot}
  let fanStrike = null;              // which typebar is striking {i,t}
  let caretVisCol = 0, caretVisRow = 0;
  let released = false, relAmt = 0;

  // ---- view-side input modality (model owns the actual shift state) ----
  let physDown = false, latch = false;

  // ---- helpers ----
  const div = (cls) => { const d = document.createElement("div"); d.className = cls; return d; };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const isLetter = (k) => k.lo >= "a" && k.lo <= "z";

  // ---- elements ----
  const cv = document.getElementById("paper"), ctx = cv.getContext("2d");
  const lid = document.getElementById("lid"), ctxL = lid.getContext("2d");
  const deck = document.querySelector(".deck");
  const carriage = document.getElementById("carriage");
  const paperFrame = carriage.querySelector(".paper-frame");
  const rrect = (c, x, y, w, h, r) => { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); };
  const colToX = (col) => padL + col * charW;
  const rowToY = (row) => {
    const norm = printLineY + (row - caretVisRow) * ROWH;
    if (relAmt <= 0) return norm;
    const rel = (FS + 10) + row * ROWH;          // released: show the page from the top
    return norm + (rel - norm) * relAmt;
  };

  // ---- paper canvas layout ----
  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.font = FONT; charW = ctx.measureText("M").width || FS * 0.6;
    padL = 48; padR = 48;        // equal margins both sides; positionCarriage keeps col0 at the deck centre
    pageW = Math.round(padL + COLS * charW + padR);
    printLineY = 8 + (VIS_ROWS - 1) * ROWH + FS;
    platenTopY = printLineY + 6;
    pageH = platenTopY + PLATEN_H;
    cv.style.width = pageW + "px"; cv.style.height = pageH + "px";
    cv.width = Math.round(pageW * dpr); cv.height = Math.round(pageH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.font = FONT;
    deck.style.height = pageH + "px";
  }

  function drawPaper() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
    ctx.font = FONT;
    ctx.fillStyle = "#f3ecdb"; ctx.fillRect(0, 0, pageW, pageH);                 // the sheet
    ctx.fillStyle = "rgba(0,0,0,.05)"; ctx.fillRect(0, 0, pageW, 6);             // faint top edge
    const clipBottom = platenTopY + (pageH - platenTopY) * relAmt;              // released: reveal whole page
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, clipBottom); ctx.clip();
    for (const s of stamps) {
      const y = rowToY(s.row); if (y < -ROWH || y > clipBottom + ROWH) continue;
      const x = colToX(s.col);
      ctx.save(); ctx.translate(x + s.jx, y + s.jy); if (s.rot) ctx.rotate(s.rot);
      ctx.fillStyle = `rgba(43,42,38,${s.a})`; ctx.fillText(s.ch, 0, 0); ctx.restore();
    }
    if (relAmt < 0.5) {
      const cx = colToX(tw.caret.col), cy = rowToY(tw.caret.row);
      ctx.fillStyle = "#c0392b"; ctx.globalAlpha = .9 * (1 - relAmt * 2); ctx.fillRect(cx, cy + 4, charW, 2); ctx.globalAlpha = 1;
    }
    ctx.restore();
    // platen roller along the bottom (fades out when the paper is released)
    if (relAmt < 1) {
      ctx.globalAlpha = 1 - relAmt;
      const g = ctx.createLinearGradient(0, platenTopY, 0, pageH);
      g.addColorStop(0, "#3a3a31"); g.addColorStop(.5, "#26261f"); g.addColorStop(1, "#15140f");
      ctx.fillStyle = g; rrect(ctx, 0, platenTopY, pageW, pageH - platenTopY, 4); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.1)"; ctx.fillRect(0, platenTopY, pageW, 2);
      ctx.globalAlpha = 1;
    }
  }

  // ---- type-basket fan, drawn self-contained in the lid (the panel between paper & keyboard) ----
  let lidW = 0, lidH = 0;
  const fanCodes = LAYOUT.rows.flat().map((k) => k.code);    // one typebar per character key
  const fanIndex = new Map(); fanCodes.forEach((c, i) => fanIndex.set(c, i));
  const fanN = fanCodes.length;

  function layoutLid() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = lid.getBoundingClientRect();
    lidW = r.width; lidH = r.height;
    lid.width = Math.round(lidW * dpr); lid.height = Math.round(lidH * dpr);
    ctxL.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function positionCarriage() {
    carriage.style.transform = "translateX(0px)";
    const dr = deck.getBoundingClientRect();
    carriage.style.left = (dr.width / 2 - paperFrame.offsetLeft - padL) + "px";
  }
  function drawFan() {
    if (!lidW) return;
    ctxL.clearRect(0, 0, lidW, lidH);
    ctxL.globalAlpha = 1 - relAmt;
    const apexX = lidW / 2, apexY = 6;               // print point at the lid top-centre
    const R = lidH - 12, ri = R * 0.22;
    const PHI = 54 * Math.PI / 180, A0 = Math.PI / 2 - PHI, A1 = Math.PI / 2 + PHI;
    const now = performance.now();
    const aOf = (i) => Math.PI / 2 - PHI * (fanN > 1 ? (2 * i / (fanN - 1) - 1) : 0);
    const pt = (a, r) => ({ x: apexX + r * Math.cos(a), y: apexY + r * Math.sin(a) });

    // fan-shaped hole (dark machine interior seen through the lid)
    ctxL.beginPath(); ctxL.moveTo(apexX, apexY); ctxL.arc(apexX, apexY, R, A0, A1); ctxL.closePath();
    const rg = ctxL.createRadialGradient(apexX, apexY, ri, apexX, apexY, R);
    rg.addColorStop(0, "rgba(26,24,20,.96)"); rg.addColorStop(1, "rgba(8,7,5,.99)");
    ctxL.fillStyle = rg; ctxL.fill();
    ctxL.strokeStyle = "rgba(255,255,255,.07)"; ctxL.lineWidth = 2;
    ctxL.beginPath(); ctxL.arc(apexX, apexY, R, A0, A1); ctxL.stroke();

    // typebars + resting silver slug heads on the outer arc
    for (let i = 0; i < fanN; i++) {
      const a = aOf(i), inner = pt(a, ri), s = pt(a, R);
      const on = fanStrike && fanStrike.i === i && (now - fanStrike.t) < 170;
      ctxL.strokeStyle = on ? "rgba(195,190,175,.95)" : "rgba(150,144,128,.55)";
      ctxL.lineWidth = on ? 2 : 1.2;
      ctxL.beginPath(); ctxL.moveTo(inner.x, inner.y); ctxL.lineTo(s.x, s.y); ctxL.stroke();
      if (!on) { ctxL.fillStyle = "#d2d5d7"; ctxL.beginPath(); ctxL.arc(s.x, s.y, 2.3, 0, Math.PI * 2); ctxL.fill(); }
    }
    // hub (the fan handle) that seats the typebars, at the print point
    const hcY = apexY + 5;
    ctxL.beginPath(); ctxL.arc(apexX, hcY, ri, 0, Math.PI); ctxL.closePath();
    const hg = ctxL.createLinearGradient(apexX, hcY - ri, apexX, hcY + ri);
    hg.addColorStop(0, "rgba(86,81,70,1)"); hg.addColorStop(1, "rgba(28,26,22,1)");
    ctxL.fillStyle = hg; ctxL.fill();
    ctxL.strokeStyle = "rgba(210,205,190,.55)"; ctxL.lineWidth = 1.4;
    ctxL.beginPath(); ctxL.arc(apexX, hcY, ri, 0, Math.PI); ctxL.stroke();
    // struck typebar swings its silver head up to the print point
    if (fanStrike) {
      const tt = (now - fanStrike.t) / 170;
      if (tt < 1) {
        const a = aOf(fanStrike.i), f = Math.sin(Math.PI * tt), s = pt(a, R);
        const x = s.x + (apexX - s.x) * f, y = s.y + (apexY - s.y) * f;
        ctxL.fillStyle = "#eef1f3"; ctxL.beginPath(); ctxL.arc(x, y, 2.8, 0, Math.PI * 2); ctxL.fill();
        if (f > 0.82) { ctxL.fillStyle = `rgba(60,55,48,${(f - 0.82) / 0.18 * 0.5})`; ctxL.beginPath(); ctxL.arc(apexX, apexY, 4.5, 0, Math.PI * 2); ctxL.fill(); }
      } else fanStrike = null;
    }
    ctxL.globalAlpha = 1;
  }

  function frame() {
    const tc = tw.caret.col, tr = tw.caret.row;
    if (reduce) { caretVisCol = tc; caretVisRow = tr; relAmt = released ? 1 : 0; }
    else {
      caretVisCol += (tc - caretVisCol) * 0.4; caretVisRow += (tr - caretVisRow) * 0.32;
      if (Math.abs(tc - caretVisCol) < 0.01) caretVisCol = tc;
      if (Math.abs(tr - caretVisRow) < 0.01) caretVisRow = tr;
      const rt = released ? 1 : 0; relAmt += (rt - relAmt) * 0.18; if (Math.abs(rt - relAmt) < 0.01) relAmt = rt;
    }
    const relX = padL - pageW / 2;                                    // released: centre the whole sheet on screen
    const x = (-caretVisCol * charW) * (1 - relAmt) + relX * relAmt;
    carriage.style.transform = `translateX(${x.toFixed(2)}px)`;        // slides while typing; sheet centred when released
    drawPaper(); drawFan();
    requestAnimationFrame(frame);
  }

  // ---- keyboard build ----
  const kb = document.getElementById("keyboard"), keyMap = new Map();
  function makeCharKey(k) {
    const el = div("key" + (isLetter(k) ? "" : " dual"));
    el.dataset.code = k.code;
    el.innerHTML = isLetter(k) ? `<b>${esc(k.up)}</b>` : `<span class="up">${esc(k.up)}</span><b>${esc(k.lo)}</b>`;
    keyMap.set(k.code, el); return el;
  }
  const SPECIAL = {
    CapsLock: { cls: "mod lock", html: "SHIFT<br>LOCK" },
    ShiftLeft: { cls: "mod shift shift-l", html: '<span class="ic">⇧</span>' },
    ShiftRight: { cls: "mod shift shift-r", html: '<span class="ic">⇧</span>' },
    Backspace: { cls: "mod back", html: "◂◂" },
    Space: { cls: "space", html: "" },
  };
  function makeMod(code) { const d = SPECIAL[code]; const el = div("key " + d.cls); el.dataset.code = code; el.innerHTML = d.html; keyMap.set(code, el); return el; }
  const BUILD = [
    { keys: LAYOUT.rows[0] },
    { keys: LAYOUT.rows[1], after: ["Backspace"] },
    { before: ["CapsLock"], keys: LAYOUT.rows[2] },
    { before: ["ShiftLeft"], keys: LAYOUT.rows[3], after: ["ShiftRight"] },
  ];
  BUILD.forEach((spec) => {
    const r = div("krow");
    (spec.before || []).forEach((c) => r.appendChild(makeMod(c)));
    spec.keys.forEach((k) => r.appendChild(makeCharKey(k)));
    (spec.after || []).forEach((c) => r.appendChild(makeMod(c)));
    kb.appendChild(r);
  });
  const spaceRow = div("krow"); spaceRow.appendChild(makeMod("Space")); kb.appendChild(spaceRow);

  // ---- actions ----
  function addStamp(res) {
    stamps.push({
      row: res.row, col: res.col, ch: res.char,
      jx: (Math.random() - .5) * 1.4, jy: (Math.random() - .5) * 1.4,
      a: .78 + Math.random() * .22, rot: (Math.random() - .5) * .03,
    });
  }
  function emitChar(code) {
    const res = tw.pressKey(code);
    if (res.printed) { addStamp(res); fanStrike = { i: fanIndex.get(code) || 0, t: performance.now() }; sndKey(); if (res.bell) { flashBell(); sndBell(); } }
    else if (res.locked) sndLock();
    if (latch && !physDown) { latch = false; syncShift(); }
    updateStatus();
  }
  function doSpace() { const r = tw.space(); if (r.locked) sndLock(); else { sndKey(); if (r.bell) { flashBell(); sndBell(); } } updateStatus(); }
  function doBackspace() { if (tw.backspace().moved) sndBack(); updateStatus(); }
  function doCR() { tw.carriageReturn(); sndCR(); swingLever(); updateStatus(); }
  function doLF() { tw.lineFeed(); sndLF(); leverFront(); updateStatus(); }

  // ---- shift visuals ----
  function syncShift() { tw.setShiftHeld(physDown || latch); updateShiftVisual(); }
  function updateShiftVisual() {
    document.body.classList.toggle("shift-on", tw.isShiftActive());
    const held = physDown || latch || tw.isShiftLocked();
    keyMap.get("ShiftLeft").classList.toggle("held", held);
    keyMap.get("ShiftRight").classList.toggle("held", held);
    keyMap.get("CapsLock").classList.toggle("on", tw.isShiftLocked());
  }
  function pressVisual(code, on) {
    const el = keyMap.get(code); if (!el) return;
    if (code === "ShiftLeft" || code === "ShiftRight" || code === "CapsLock") return;
    el.classList.toggle("pressed", on);
  }

  // ---- pointer / tap ----
  keyMap.forEach((el, code) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (code === "Space") { el.classList.add("pressed"); doSpace(); return; }
      if (code === "Backspace") { el.classList.add("pressed"); doBackspace(); return; }
      if (code === "CapsLock") { tw.toggleShiftLock(); syncShift(); sndShift(); return; }
      if (code === "ShiftLeft" || code === "ShiftRight") { latch = !latch; syncShift(); if (latch) sndShift(); return; }
      el.classList.add("pressed"); emitChar(code);
    });
    el.addEventListener("pointerup", () => el.classList.remove("pressed"));
    el.addEventListener("pointerleave", () => el.classList.remove("pressed"));
  });

  // ---- physical keyboard ----
  addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("hide")) return;
    const c = e.code;
    if (c === "Escape") { e.preventDefault(); toggleRelease(); return; }
    if (c === "ShiftLeft" || c === "ShiftRight") { if (!physDown) { physDown = true; syncShift(); sndShift(); } return; }
    if (c === "CapsLock") { e.preventDefault(); tw.toggleShiftLock(); syncShift(); sndShift(); return; }
    if (c === "Enter" || c === "NumpadEnter") {
      e.preventDefault();
      if (e.shiftKey) doCR(); else if (e.ctrlKey || e.metaKey) doLF(); else { doCR(); doLF(); }
      return;
    }
    if (c === "Backspace") { e.preventDefault(); pressVisual("Backspace", true); doBackspace(); return; }
    if (c === "Space") { e.preventDefault(); pressVisual("Space", true); doSpace(); return; }
    if (codes.has(c) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); pressVisual(c, true); emitChar(c); return; }
  });
  addEventListener("keyup", (e) => {
    const c = e.code;
    if (c === "ShiftLeft" || c === "ShiftRight") { physDown = false; syncShift(); sndShiftUp(); return; }
    pressVisual(c, false);
  });
  addEventListener("blur", () => { physDown = false; latch = false; syncShift(); keyMap.forEach((el) => el.classList.remove("pressed")); });

  // ---- CR lever (right = CR, toward viewer = LF, click = CR+LF) + paper release ----
  const leverEl = document.getElementById("leverCR"), releaseEl = document.getElementById("paperRelease");
  let lvOn = false, lvX = 0, lvY = 0, lvFired = null, lvPid = null;
  leverEl.addEventListener("pointerdown", (e) => {
    e.preventDefault(); lvOn = true; lvFired = null; lvX = e.clientX; lvY = e.clientY; lvPid = e.pointerId;
    try { leverEl.setPointerCapture(e.pointerId); } catch (_) {}
  });
  leverEl.addEventListener("pointermove", (e) => {
    if (!lvOn || lvFired) return;
    const dx = e.clientX - lvX, dy = e.clientY - lvY;
    if (dx > 24 && dx >= Math.abs(dy)) { lvFired = "cr"; doCR(); }
    else if (dy > 24 && dy > Math.abs(dx)) { lvFired = "lf"; doLF(); }
  });
  function endLever() { if (!lvOn) return; lvOn = false; try { leverEl.releasePointerCapture(lvPid); } catch (_) {} if (!lvFired) { doCR(); doLF(); } }
  leverEl.addEventListener("pointerup", endLever);
  leverEl.addEventListener("pointercancel", endLever);
  function toggleRelease() {
    released = !released;
    releaseEl.classList.toggle("pulled", released);
    releaseEl.setAttribute("aria-pressed", String(released));
    document.body.classList.toggle("released", released);
    sndRelease();
  }
  releaseEl.addEventListener("click", toggleRelease);
  function swingLever() { leverEl.classList.remove("front"); leverEl.classList.add("swing"); setTimeout(() => leverEl.classList.remove("swing"), 240); }
  function leverFront() { leverEl.classList.remove("swing"); leverEl.classList.add("front"); setTimeout(() => leverEl.classList.remove("front"), 240); }

  // ---- status ----
  const statusEl = document.getElementById("status"), bellDot = document.getElementById("belldot");
  function updateStatus() { statusEl.firstChild.nodeValue = `行 ${tw.caret.row + 1} · 桁 ${tw.caret.col + 1} `; }
  let bellTimer; function flashBell() { bellDot.classList.add("on"); clearTimeout(bellTimer); bellTimer = setTimeout(() => bellDot.classList.remove("on"), 260); }

  // ---- Web Audio (all voices share a compressor bus so loud hits stay punchy, not clipped) ----
  let actx = null, busIn = null;
  function ac() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 24; comp.ratio.value = 4; comp.attack.value = .003; comp.release.value = .18;
      const master = actx.createGain(); master.gain.value = .92;
      comp.connect(master); master.connect(actx.destination); busIn = comp;
    }
    return actx;
  }
  const out = () => { ac(); return busIn; };
  function noiseBuf(d) { const c = ac(), n = Math.floor(c.sampleRate * d), b = c.createBuffer(1, n, c.sampleRate), a = b.getChannelData(0); for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1; return b; }
  function burst({ dur = .04, freq = 2200, q = 1, type = "bandpass", gain = .5, decay = null, t = 0 } = {}) {
    const c = ac(), s = c.createBufferSource(); s.buffer = noiseBuf(dur);
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(), now = c.currentTime + t, d = decay ?? dur;
    g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(.0001, now + d);
    s.connect(f); f.connect(g); g.connect(out()); s.start(now); s.stop(now + d + .02);
  }
  function tone({ freq = 1000, dur = .18, gain = .25, type = "sine", t = 0 } = {}) {
    const c = ac(), o = c.createOscillator(), g = c.createGain(), now = c.currentTime + t;
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(.0001, now + dur);
    o.connect(g); g.connect(out()); o.start(now); o.stop(now + dur + .02);
  }
  const sndKey = () => burst({ dur: .03, freq: 2400, q: .8, gain: .45, decay: .05 });
  const sndBack = () => burst({ dur: .03, freq: 1500, q: 1, gain: .3, decay: .05 });
  const sndLock = () => burst({ dur: .02, freq: 900, q: 2, gain: .25, decay: .03 });
  // margin bell — short, bright bicycle-bell ring (modelled on 自転車ベル2: ~5100Hz dominant + 1986Hz partial)
  const sndBell = () => {
    burst({ dur: .01, freq: 5200, q: 1, type: "highpass", gain: .16, decay: .012 });   // striker tick
    tone({ freq: 5100, dur: .28, gain: .32 });                                         // main ring
    tone({ freq: 5112, dur: .28, gain: .12 });                                         // slight detune → bell warble
    tone({ freq: 1986, dur: .16, gain: .10 });                                         // lower partial
    tone({ freq: 10200, dur: .10, gain: .045 });                                       // high shimmer
  };
  // Enter / carriage return — short cash-register "ching" (modelled on レジ: clack then a bright inharmonic bell ~6674/10510Hz)
  function sndCR() {
    burst({ dur: .03, freq: 2600, q: .7, gain: .5, decay: .035 });                     // ka — key/drawer clack
    burst({ dur: .015, freq: 700, q: .5, type: "lowpass", gain: .3, decay: .02 });     //      clack body
    const b = .012;                                                                    // ching a hair after the clack
    tone({ freq: 6674, dur: .22, gain: .34, t: b });                                   // bright bell (dominant partial)
    tone({ freq: 10510, dur: .16, gain: .18, t: b });                                  // shimmer partial (sample is bright)
    tone({ freq: 3050, dur: .18, gain: .12, t: b });                                   // body partial
    tone({ freq: 3950, dur: .13, gain: .07, type: "triangle", t: b });
  }
  function sndLF() { burst({ dur: .025, freq: 1800, q: 1.5, gain: .35, decay: .03 }); setTimeout(() => burst({ dur: .025, freq: 1400, q: 1.5, gain: .28, decay: .03 }), 55); }
  function sndShift() { burst({ dur: .05, freq: 360, q: .6, type: "lowpass", gain: .4, decay: .07 }); setTimeout(() => burst({ dur: .03, freq: 1600, q: 1.4, gain: .32, decay: .04 }), 32); }
  function sndShiftUp() { burst({ dur: .04, freq: 300, q: .6, type: "lowpass", gain: .28, decay: .05 }); }
  // paper release — a page-turn rustle (modelled on ページめくり2: broadband paper noise that swishes up, with a flick)
  function sndRelease() {
    const c = ac(), now = c.currentTime, dur = .5;
    const src = c.createBufferSource(); src.buffer = noiseBuf(dur);
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 220;     // keep the paper body, drop rumble
    const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = .6;
    bp.frequency.setValueAtTime(550, now);
    bp.frequency.linearRampToValueAtTime(1400, now + .30);                                 // swish up as the sheet turns
    bp.frequency.linearRampToValueAtTime(850, now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(.0001, now);
    g.gain.linearRampToValueAtTime(.12, now + .05);                                        // soft rustle...
    g.gain.linearRampToValueAtTime(.06, now + .17);
    g.gain.linearRampToValueAtTime(.34, now + .30);                                        // ...building to the main flick
    g.gain.linearRampToValueAtTime(.12, now + .40);
    g.gain.exponentialRampToValueAtTime(.0001, now + dur);
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out());
    src.start(now); src.stop(now + dur + .02);
  }

  // ---- startup ----
  const overlay = document.getElementById("overlay");
  function layoutAll() { layout(); positionCarriage(); layoutLid(); }
  overlay.addEventListener("click", () => { overlay.classList.add("hide"); const c = ac(); if (c.resume) c.resume(); layoutAll(); updateStatus(); }, { once: true });
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layoutAll, 120); });
  // re-run layout whenever the machine actually gets/changes its size (preview viewport can settle late)
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(layoutAll, 60); }); ro.observe(document.querySelector(".machine")); }
  layoutAll(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);
  requestAnimationFrame(frame);
})();
