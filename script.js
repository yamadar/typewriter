/*
 * script.js — view / IO layer for the typewriter.
 *
 * Typing logic lives in the model (typewriter-model.js, unit-tested). This file
 * builds the keyboard from LAYOUT, wires input, renders the paper + mechanism on
 * <canvas>, and plays Web Audio.
 *
 * Look & mechanism (see docs/typewriter-mechanism.md):
 *  - Antique round black keys; modifiers placed like a real board: Shift Lock left
 *    of A, left Shift left of Z, right Shift right of /?, Backspace right of P,
 *    a wide Space bar on its own row.
 *  - Below the keys, a mechanism canvas draws each key's arm/typebar converging to
 *    the single type-basket strike point; pressing a key swings its hammer there.
 *  - The PRINT POINT on the paper is FIXED; the paper (carriage) moves: left while
 *    typing, back right on CR, up on LF. Single SHIFT picks the upper glyph for all
 *    keys; SHIFT LOCK latches it for all. CR/LF are separate.
 *  - Carriage-return lever: pull right = CR, pull toward you (down) = LF, click = CR+LF.
 *  - Paper-release lever: detaches the sheet and shows the typed page on its own.
 */
(() => {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;

  const tw = createTypewriter();
  const COLS = tw.cols;
  const codes = new Set(LAYOUT.rows.flat().map((k) => k.code));

  // ---- paper canvas geometry ----
  const VIS_ROWS = 12, FS = 19, ROWH = Math.round(FS * 1.5);
  const PAD_X = 22, PAD_Y = 16, PLATEN_H = 30, FONT = `${FS}px "Courier Prime","Courier New",monospace`;
  let charW = FS * 0.6, cssW = 0, cssH = 0, printX = 0, printY = 0, platenTop = 0;

  // ---- render state ----
  const stamps = [];                 // {row,col,ch,jx,jy,a,rot}
  let strike = null;                 // paper hammer animation {t}
  let mechStrike = null;             // mechanism hammer {code,t}
  let caretVisCol = 0, caretVisRow = 0; // animated carriage position
  let released = false, relAmt = 0;  // paper-release (0 engaged .. 1 detached)

  // ---- view-side input modality (model owns the actual shift state) ----
  let physDown = false, latch = false;

  // ---- small DOM helpers ----
  const div = (cls) => { const d = document.createElement("div"); d.className = cls; return d; };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const isLetter = (k) => k.lo >= "a" && k.lo <= "z";

  // ---- paper canvas ----
  const cv = document.getElementById("paper"), ctx = cv.getContext("2d");
  const rrect = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  const colToX = (c) => printX + (c - caretVisCol) * charW;
  const rowToY = (r) => printY + (r - caretVisRow) * ROWH;

  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.font = FONT; charW = ctx.measureText("M").width || FS * 0.6;
    cssW = COLS * charW + PAD_X * 2; cssH = VIS_ROWS * ROWH + PAD_Y * 2 + PLATEN_H;
    printX = Math.round(cssW * 0.5); printY = cssH - PLATEN_H - 14; platenTop = printY + 8;
    cv.style.aspectRatio = `${cssW} / ${cssH}`;
    const realW = cv.clientWidth || cssW, scale = realW / cssW;
    cv.width = Math.round(realW * dpr); cv.height = Math.round(cssH * scale * dpr);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  }

  function draw() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
    ctx.font = FONT;
    if (relAmt < 1) drawMachine(1 - relAmt);
    if (relAmt > 0) drawReleased(relAmt);
  }

  function drawMachine(alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = "#f3ecdb"; ctx.fillRect(0, 0, cssW, cssH);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cssW, platenTop); ctx.clip();
    for (const s of stamps) {
      const x = colToX(s.col); if (x < -charW || x > cssW + charW) continue;
      const y = rowToY(s.row); if (y < -ROWH || y > platenTop + ROWH) continue;
      ctx.save(); ctx.translate(x + s.jx, y + s.jy); if (s.rot) ctx.rotate(s.rot);
      ctx.fillStyle = `rgba(43,42,38,${s.a})`; ctx.fillText(s.ch, 0, 0); ctx.restore();
    }
    const cx = colToX(tw.caret.col), cy = rowToY(tw.caret.row);
    ctx.fillStyle = "#c0392b"; ctx.globalAlpha = alpha * 0.9; ctx.fillRect(cx, cy + 4, charW, 2);
    ctx.restore();
    drawPlaten();
    drawPaperHammer();
    drawPrintGuide();
    ctx.restore();
  }

  function drawPlaten() {
    const top = platenTop, h = cssH - top;
    const g = ctx.createLinearGradient(0, top, 0, cssH);
    g.addColorStop(0, "#3a3a31"); g.addColorStop(.5, "#26261f"); g.addColorStop(1, "#15140f");
    ctx.fillStyle = g; rrect(-10, top, cssW + 20, h, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.10)"; ctx.fillRect(-10, top, cssW + 20, 2);
    const off = -caretVisCol * charW, sp = charW * 2;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, cssW, h); ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
    const startX = ((off % sp) + sp) % sp - sp;
    for (let x = startX; x < cssW + sp; x += sp) { ctx.beginPath(); ctx.moveTo(x, top + 5); ctx.lineTo(x, cssH - 5); ctx.stroke(); }
    ctx.restore();
  }

  function drawPaperHammer() {
    if (!strike) return;
    const t = (performance.now() - strike.t) / 120;
    if (t >= 1) { strike = null; return; }
    const hit = Math.sin(Math.PI * t);
    const slugY = printY + (1 - hit) * ((cssH - printY) + 14);
    ctx.strokeStyle = "#2b2a26"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(printX, cssH + 14); ctx.lineTo(printX, slugY); ctx.stroke();
    ctx.fillStyle = "#1c1b17"; rrect(printX - 7, slugY - 7, 14, 11, 3); ctx.fill();
    if (hit > 0.8) { ctx.fillStyle = `rgba(43,42,38,${(hit - 0.8) / 0.2 * 0.5})`; ctx.beginPath(); ctx.arc(printX, printY - 2, 2.4, 0, Math.PI * 2); ctx.fill(); }
  }

  function drawPrintGuide() {
    ctx.strokeStyle = "rgba(192,57,43,.6)"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(printX - 7, printY - 3); ctx.lineTo(printX - 7, printY + 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(printX + 7, printY - 3); ctx.lineTo(printX + 7, printY + 7); ctx.stroke();
  }

  function drawReleased(alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = "#1d1a16"; ctx.fillRect(0, 0, cssW, cssH);
    let maxRow = tw.caret.row, maxCol = tw.caret.col;
    for (const s of stamps) { if (s.row > maxRow) maxRow = s.row; if (s.col + 1 > maxCol) maxCol = s.col + 1; }
    const padX = 18, padY = 16;
    const pageRows = Math.max(maxRow + 1, 6), pageCols = Math.max(maxCol, COLS);
    const sheetW = pageCols * charW + padX * 2, sheetH = pageRows * ROWH + padY * 2;
    const sc = Math.min(1, (cssW - 24) / sheetW, (cssH - 24) / sheetH);
    const dw = sheetW * sc, dh = sheetH * sc, ox = (cssW - dw) / 2, oy = (cssH - dh) / 2 - (1 - alpha) * 18;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#faf4e6"; rrect(ox, oy, dw, dh, 6); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, dw, dh); ctx.clip();
    ctx.translate(ox, oy); ctx.scale(sc, sc); ctx.font = FONT;
    const baseTop = padY + FS;
    for (const s of stamps) {
      ctx.save(); ctx.translate(padX + s.col * charW + s.jx, baseTop + s.row * ROWH + s.jy); if (s.rot) ctx.rotate(s.rot);
      ctx.fillStyle = `rgba(43,42,38,${s.a})`; ctx.fillText(s.ch, 0, 0); ctx.restore();
    }
    ctx.restore(); ctx.restore();
  }

  // ---- mechanism canvas (key -> arm -> hammer, all converging to one strike point) ----
  const mech = document.getElementById("mech"), ctxM = mech.getContext("2d");
  let mechW = 0, mechH = 0;
  const keyGeo = []; // {code, x (center, relative to mech), isChar}
  function layoutMech() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    mechW = mech.clientWidth || cssW; mechH = mech.clientHeight || 96;
    mech.width = Math.round(mechW * dpr); mech.height = Math.round(mechH * dpr);
    ctxM.setTransform(dpr, 0, 0, dpr, 0, 0);
    measureMech();
  }
  function measureMech() {
    const mr = mech.getBoundingClientRect(); keyGeo.length = 0;
    keyMap.forEach((el, code) => {
      const r = el.getBoundingClientRect();
      keyGeo.push({ code, x: r.left + r.width / 2 - mr.left, isChar: codes.has(code) });
    });
  }
  function drawMech() {
    if (!mechW) return;
    ctxM.clearRect(0, 0, mechW, mechH);
    const apexX = mechW / 2, apexY = mechH - 6, now = performance.now();
    for (const k of keyGeo) {
      if (k.isChar) {
        let f = 0, active = false;
        if (mechStrike && mechStrike.code === k.code) {
          const t = (now - mechStrike.t) / 130;
          if (t < 1) { f = Math.sin(Math.PI * t); active = true; }
        }
        // arm/typebar: faint linkage from the key down to the common strike point
        ctxM.strokeStyle = active ? "rgba(232,227,214,.9)" : "rgba(206,201,186,.13)";
        ctxM.lineWidth = active ? 2.4 : 1.1;
        ctxM.beginPath(); ctxM.moveTo(k.x, 3); ctxM.lineTo(apexX, apexY); ctxM.stroke();
        // hammer/slug travelling to the strike point on a keystroke
        if (active) {
          const sx = k.x + (apexX - k.x) * f, sy = 3 + (apexY - 3) * f;
          ctxM.fillStyle = "#15140f"; ctxM.beginPath(); ctxM.arc(sx, sy, 3.4, 0, Math.PI * 2); ctxM.fill();
          if (f > 0.78) { ctxM.fillStyle = `rgba(192,57,43,${(f - 0.78) / 0.22 * 0.8})`; ctxM.beginPath(); ctxM.arc(apexX, apexY, 4.5, 0, Math.PI * 2); ctxM.fill(); }
        }
      } else {
        // modifier keys: short arm stub (no typebar)
        ctxM.strokeStyle = "rgba(206,201,186,.10)"; ctxM.lineWidth = 1.1;
        ctxM.beginPath(); ctxM.moveTo(k.x, 3); ctxM.lineTo(k.x, mechH * 0.42); ctxM.stroke();
      }
    }
    if (mechStrike && now - mechStrike.t > 150) mechStrike = null;
    ctxM.fillStyle = "rgba(120,116,104,.5)"; ctxM.beginPath(); ctxM.arc(apexX, apexY, 4, 0, Math.PI * 2); ctxM.fill();
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
    draw(); drawMech(); requestAnimationFrame(frame);
  }

  // ---- keyboard build (real placement of the modifier keys) ----
  const kb = document.getElementById("keyboard"), keyMap = new Map();
  function makeCharKey(k) {
    const el = div("key" + (isLetter(k) ? "" : " dual"));
    el.dataset.code = k.code;
    el.innerHTML = isLetter(k) ? `<b>${esc(k.up)}</b>` : `<span class="up">${esc(k.up)}</span><b>${esc(k.lo)}</b>`;
    keyMap.set(k.code, el); return el;
  }
  const SPECIAL = {
    CapsLock: { cls: "mod lock", html: "SHIFT<br>LOCK" },
    ShiftLeft: { cls: "mod shift", html: '<span class="ic">⇧</span>' },
    ShiftRight: { cls: "mod shift", html: '<span class="ic">⇧</span>' },
    Backspace: { cls: "mod back", html: "◂◂" },
    Space: { cls: "space", html: "" },
  };
  function makeMod(code) {
    const d = SPECIAL[code]; const el = div("key " + d.cls); el.dataset.code = code; el.innerHTML = d.html;
    keyMap.set(code, el); return el;
  }
  const BUILD = [
    { keys: LAYOUT.rows[0] },                                          // 1 2 3 .. 0
    { keys: LAYOUT.rows[1], after: ["Backspace"] },                   // Q..P  <<
    { before: ["CapsLock"], keys: LAYOUT.rows[2] },                   // ShiftLock A..L ; '
    { before: ["ShiftLeft"], keys: LAYOUT.rows[3], after: ["ShiftRight"] }, // LShift Z..M ,./ RShift
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
    strike = { t: performance.now() };
  }
  function emitChar(code) {
    const res = tw.pressKey(code);
    if (res.printed) { addStamp(res); mechStrike = { code, t: performance.now() }; sndKey(); if (res.bell) { flashBell(); sndBell(); } }
    else if (res.locked) sndLock();
    if (latch && !physDown) { latch = false; syncShift(); }
    updateStatus();
  }
  function doSpace() {
    const r = tw.space();
    if (r.locked) sndLock(); else { sndKey(); if (r.bell) { flashBell(); sndBell(); } }
    updateStatus();
  }
  function doBackspace() { if (tw.backspace().moved) sndBack(); updateStatus(); }
  function doCR() { tw.carriageReturn(); sndCR(); swingLever(); updateStatus(); }
  function doLF() { tw.lineFeed(); sndLF(); spinKnob(); leverFront(); updateStatus(); }

  // ---- shift visuals ----
  function syncShift() { tw.setShiftHeld(physDown || latch); updateShiftVisual(); }
  function updateShiftVisual() {
    document.body.classList.toggle("shift-on", tw.isShiftActive());
    const held = physDown || latch;
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
  addEventListener("blur", () => {
    physDown = false; latch = false; syncShift();
    keyMap.forEach((el) => el.classList.remove("pressed"));
  });

  // ---- carriage-return lever: pull right = CR, pull toward you (down) = LF, click = CR+LF ----
  const leverEl = document.getElementById("leverCR"),
        knobBtn = document.getElementById("knobLF"),
        knobEl = document.getElementById("knob"),
        releaseEl = document.getElementById("paperRelease");
  let knobAngle = 0, lvOn = false, lvX = 0, lvY = 0, lvFired = null, lvPid = null;
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
  function endLever() {
    if (!lvOn) return; lvOn = false;
    try { leverEl.releasePointerCapture(lvPid); } catch (_) {}
    if (!lvFired) { doCR(); doLF(); } // a plain pull does a full return
  }
  leverEl.addEventListener("pointerup", endLever);
  leverEl.addEventListener("pointercancel", endLever);
  knobBtn.addEventListener("click", doLF);
  releaseEl.addEventListener("click", () => {
    released = !released;
    releaseEl.classList.toggle("pulled", released);
    releaseEl.setAttribute("aria-pressed", String(released));
    sndRelease();
  });
  function swingLever() { if (reduce) return; leverEl.classList.add("swing"); setTimeout(() => leverEl.classList.remove("swing"), 160); }
  function leverFront() { if (reduce) return; leverEl.classList.add("front"); setTimeout(() => leverEl.classList.remove("front"), 170); }
  function spinKnob() { if (reduce) return; knobAngle += 52; knobEl.style.transform = `rotate(${knobAngle}deg)`; }

  // ---- status ----
  const statusEl = document.getElementById("status"), bellDot = document.getElementById("belldot");
  function updateStatus() { statusEl.firstChild.nodeValue = `行 ${tw.caret.row + 1} · 桁 ${tw.caret.col + 1} `; }
  let bellTimer; function flashBell() { bellDot.classList.add("on"); clearTimeout(bellTimer); bellTimer = setTimeout(() => bellDot.classList.remove("on"), 260); }

  // ---- Web Audio ----
  let actx = null; const ac = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());
  function noiseBuf(d) { const c = ac(), n = Math.floor(c.sampleRate * d), b = c.createBuffer(1, n, c.sampleRate), a = b.getChannelData(0); for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1; return b; }
  function burst({ dur = .04, freq = 2200, q = 1, type = "bandpass", gain = .5, decay = null } = {}) {
    const c = ac(), s = c.createBufferSource(); s.buffer = noiseBuf(dur);
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(), now = c.currentTime, d = decay ?? dur;
    g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(.0001, now + d);
    s.connect(f); f.connect(g); g.connect(c.destination); s.start(); s.stop(now + d + .02);
  }
  function tone({ freq = 1000, dur = .18, gain = .25, type = "sine" } = {}) {
    const c = ac(), o = c.createOscillator(), g = c.createGain(), now = c.currentTime;
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(.0001, now + dur);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(now + dur + .02);
  }
  const sndKey = () => burst({ dur: .03, freq: 2400, q: .8, gain: .45, decay: .05 });
  const sndBack = () => burst({ dur: .03, freq: 1500, q: 1, gain: .3, decay: .05 });
  const sndLock = () => burst({ dur: .02, freq: 900, q: 2, gain: .25, decay: .03 });
  const sndBell = () => { tone({ freq: 1050, dur: .22, gain: .22 }); tone({ freq: 1560, dur: .18, gain: .12 }); };
  function sndCR() { burst({ dur: .16, freq: 600, q: .5, type: "lowpass", gain: .3, decay: .18 }); setTimeout(() => burst({ dur: .04, freq: 1200, q: 1, gain: .4, decay: .06 }), 130); }
  function sndLF() { burst({ dur: .025, freq: 1800, q: 1.5, gain: .35, decay: .03 }); setTimeout(() => burst({ dur: .025, freq: 1400, q: 1.5, gain: .28, decay: .03 }), 55); }
  function sndShift() { burst({ dur: .05, freq: 360, q: .6, type: "lowpass", gain: .4, decay: .07 }); setTimeout(() => burst({ dur: .03, freq: 1600, q: 1.4, gain: .32, decay: .04 }), 32); }
  function sndShiftUp() { burst({ dur: .04, freq: 300, q: .6, type: "lowpass", gain: .28, decay: .05 }); }
  function sndRelease() { burst({ dur: .09, freq: 240, q: .5, type: "lowpass", gain: .4, decay: .12 }); setTimeout(() => burst({ dur: .05, freq: 3000, q: .5, type: "highpass", gain: .12, decay: .08 }), 70); }

  // ---- startup ----
  const overlay = document.getElementById("overlay");
  function layoutAll() { layout(); layoutMech(); }
  overlay.addEventListener("click", () => {
    overlay.classList.add("hide"); const c = ac(); if (c.resume) c.resume();
    layoutAll(); updateStatus();
  }, { once: true });
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layoutAll, 120); });
  layoutAll(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);
  requestAnimationFrame(frame);
})();
