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
  const FS = 17, ROWH = Math.round(FS * 1.5), GAP = 8, VIS_ROWS = 5;   // realistic: only a few lines on the platen front
  const BACK_H = 14, ROLLER_MIN = 26, TOP_MARGIN = 26;                 // platen scene: back-paper band / min roller / sheet top margin
  const FONT = `${FS}px "Courier Prime","Courier New",monospace`;
  // equal margins on both sides of the text; the print point stays at the deck centre
  let charW = FS * 0.6, padL = 48, padR = 48, pageW = 0, pageH = 0, curH = 0, printLineY = 0, platenTopY = 0;

  // ---- render state ----
  const stamps = [];                 // {row,col,ch,jx,jy,a,rot}
  let fanStrike = null;              // which typebar is striking {i,t}
  let caretVisCol = 0, caretVisY = 0;   // eased carriage column and vertical scroll (px)
  let colTarget = 0, stepGen = 0;    // carriage steps to colTarget AFTER the hammer strikes (escapement)
  let released = false, relAmt = 0;
  let lineHeight = 1.5;              // LF spacing factor: 1.0 single / 1.5 / 2.0 double
  let inkColor = "43,42,38";        // ribbon ink (r,g,b): black by default
  const rowTop = [0];                // cumulative top px per row (depends on the line-height at each LF)
  const STEP_DELAY = 100;           // ms after a keystrike before the paper steps one character (≈ strike contact)

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
  const sheetView = document.getElementById("sheetView");
  const rrect = (c, x, y, w, h, r) => { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); };
  const colToX = (col) => padL + col * charW;
  const lineAdvance = () => Math.round(FS * lineHeight);   // px the paper feeds up per LF
  const rowToY = (row) => {
    const top = rowTop[row] != null ? rowTop[row] : (rowTop[rowTop.length - 1] || 0);
    const norm = printLineY + (top - caretVisY);
    if (relAmt <= 0) return norm;
    const rel = (FS + 10) + top;                  // released: show the page from the top
    return norm + (rel - norm) * relAmt;
  };

  // ---- paper canvas layout ----
  function layout() {
    ctx.font = FONT; charW = ctx.measureText("M").width || FS * 0.6;
    padL = 48; padR = 48;        // equal margins both sides; positionCarriage keeps col0 at the deck centre
    pageW = Math.round(padL + COLS * charW + padR);
    printLineY = BACK_H + ROLLER_MIN + 10 + (VIS_ROWS - 1) * ROWH + FS;   // front window sits below the platen roller
    platenTopY = printLineY + 4;
    pageH = printLineY + 18;                                              // room for the bail / descenders below the print line
    setCanvasH(pageH);                    // canvas backing + ctx (grows when the released sheet needs > VIS_ROWS rows)
    deck.style.height = pageH + "px";
  }
  // size the paper canvas to height h (CSS px): normal view uses pageH, the released sheet grows to fit all rows
  function setCanvasH(h) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    curH = h;
    cv.style.width = pageW + "px"; cv.style.height = h + "px";
    cv.width = Math.round(pageW * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.font = FONT;
  }

  function drawPaper() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore();
    ctx.font = FONT;
    ctx.fillStyle = "#f3ecdb"; ctx.fillRect(0, 0, pageW, curH);                 // the sheet (full current height)
    ctx.fillStyle = "rgba(0,0,0,.05)"; ctx.fillRect(0, 0, pageW, 6);             // faint top edge
    const clipBottom = platenTopY + (curH - platenTopY) * relAmt;              // released: reveal the whole page
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, clipBottom); ctx.clip();
    for (const s of stamps) {
      const y = rowToY(s.row); if (y < -ROWH || y > clipBottom + ROWH) continue;
      const x = colToX(s.col);
      ctx.save(); ctx.translate(x + s.jx, y + s.jy); if (s.rot) ctx.rotate(s.rot);
      ctx.fillStyle = `rgba(${s.ink || "43,42,38"},${s.a})`; ctx.fillText(s.ch, 0, 0); ctx.restore();
    }
    if (relAmt < 0.5) {
      const cx = colToX(colTarget), cy = rowToY(tw.caret.row);   // caret sits at the print point (carriage target)
      ctx.fillStyle = "#c0392b"; ctx.globalAlpha = .9 * (1 - relAmt * 2); ctx.fillRect(cx, cy + 4, charW, 2); ctx.globalAlpha = 1;
    }
    ctx.restore();
    // platen scene (black roller / back of fed sheet / top edge / paper bail) — typing view only; fades on release
    if (relAmt < 1 && curH === pageH) drawPlaten(1 - relAmt);
  }
  // the paper wrapped on the platen: black roller behind, the fed sheet's back face above it, the sheet's top edge, the paper bail
  function drawPlaten(al) {
    ctx.globalAlpha = al;
    const topEdgeY = printLineY - caretVisY - TOP_MARGIN;                          // sheet top edge — scrolls up as you type
    const rollerBottom = Math.max(BACK_H + ROLLER_MIN, Math.min(topEdgeY, printLineY - 6));
    // (a) black platen roller (cylinder): from under the back-sheet down to the sheet's top edge
    const rg = ctx.createLinearGradient(0, BACK_H, 0, rollerBottom);
    rg.addColorStop(0, "#15140f"); rg.addColorStop(.42, "#34322b"); rg.addColorStop(.52, "#3e3c34"); rg.addColorStop(.62, "#2a2823"); rg.addColorStop(1, "#121109");
    ctx.fillStyle = rg; ctx.fillRect(0, BACK_H, pageW, rollerBottom - BACK_H);
    // (b) back of the fed sheet, standing up behind the roller
    const bg = ctx.createLinearGradient(0, 0, 0, BACK_H);
    bg.addColorStop(0, "#cdc4ae"); bg.addColorStop(1, "#ded5bf");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, pageW, BACK_H);
    ctx.fillStyle = "rgba(0,0,0,.30)"; ctx.fillRect(0, BACK_H - 1, pageW, 1);                              // shadow into the roller
    // (c) the sheet's top edge (only while it is still on the front of the platen)
    if (topEdgeY >= rollerBottom - 0.5 && topEdgeY < pageH) {
      ctx.fillStyle = "rgba(0,0,0,.22)"; ctx.fillRect(0, topEdgeY, pageW, 2);
      ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(0, topEdgeY + 2, pageW, 1);
    }
    // (d) paper bail: a thin chrome bar with rubber rollers, holding the sheet just above the print line
    const bailY = printLineY - 15;
    const cgr = ctx.createLinearGradient(0, bailY - 2, 0, bailY + 2);
    cgr.addColorStop(0, "rgba(228,231,227,.92)"); cgr.addColorStop(.5, "rgba(150,154,150,.92)"); cgr.addColorStop(1, "rgba(118,122,118,.92)");
    ctx.fillStyle = cgr; rrect(ctx, 6, bailY - 2, pageW - 12, 4, 2); ctx.fill();
    for (let k = 0; k < 3; k++) {
      const bx = pageW * (0.2 + 0.3 * k);
      ctx.fillStyle = "#1b1b18"; rrect(ctx, bx - 9, bailY - 4, 18, 8, 4); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.fillRect(bx - 7, bailY - 3, 14, 1);
    }
    ctx.globalAlpha = 1;
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
    if (released) return;                       // while released the sheet is detached & centred on the screen
    carriage.style.transform = "translateX(0px)";
    const dr = deck.getBoundingClientRect();
    carriage.style.left = (dr.width / 2 - paperFrame.offsetLeft - padL) + "px";
  }
  function drawFan() {
    if (!lidW) return;
    ctxL.clearRect(0, 0, lidW, lidH);
    ctxL.globalAlpha = 1 - relAmt;
    const apexX = lidW / 2, apexY = 4;               // strike point at the lid top-centre (under the print point)
    const R = lidH - 16, ri = R * 0.22;              // big folding fan (lid raised ~1.5x in CSS)
    const PHI = 75 * Math.PI / 180, A0 = Math.PI / 2 - PHI, A1 = Math.PI / 2 + PHI;   // ~150° spread
    const now = performance.now();
    const STRIKE_MS = 200;
    const struck = (fanStrike && now - fanStrike.t < STRIKE_MS) ? fanStrike.i : -1;
    const aOf = (i) => Math.PI / 2 - PHI * (fanN > 1 ? (2 * i / (fanN - 1) - 1) : 0);
    const pt = (a, r) => ({ x: apexX + r * Math.cos(a), y: apexY + r * Math.sin(a) });

    // fan-shaped hole (dark machine interior seen through the lid)
    ctxL.beginPath(); ctxL.moveTo(apexX, apexY); ctxL.arc(apexX, apexY, R, A0, A1); ctxL.closePath();
    const rg = ctxL.createRadialGradient(apexX, apexY, ri, apexX, apexY, R);
    rg.addColorStop(0, "rgba(26,24,20,.96)"); rg.addColorStop(1, "rgba(8,7,5,.99)");
    ctxL.fillStyle = rg; ctxL.fill();
    ctxL.strokeStyle = "rgba(255,255,255,.07)"; ctxL.lineWidth = 2;
    ctxL.beginPath(); ctxL.arc(apexX, apexY, R, A0, A1); ctxL.stroke();

    // typebars + resting silver slug heads on the outer arc (the struck arm is drawn swinging, below)
    for (let i = 0; i < fanN; i++) {
      if (i === struck) continue;
      const a = aOf(i), inner = pt(a, ri), s = pt(a, R);
      ctxL.strokeStyle = "rgba(150,144,128,.55)"; ctxL.lineWidth = 1.2;
      ctxL.beginPath(); ctxL.moveTo(inner.x, inner.y); ctxL.lineTo(s.x, s.y); ctxL.stroke();
      ctxL.fillStyle = "#d2d5d7"; ctxL.beginPath(); ctxL.arc(s.x, s.y, 2.7, 0, Math.PI * 2); ctxL.fill();
    }
    // hub (the fan handle) that seats the typebars, at the print point
    const hcY = apexY + 5;
    ctxL.beginPath(); ctxL.arc(apexX, hcY, ri, 0, Math.PI); ctxL.closePath();
    const hg = ctxL.createLinearGradient(apexX, hcY - ri, apexX, hcY + ri);
    hg.addColorStop(0, "rgba(86,81,70,1)"); hg.addColorStop(1, "rgba(28,26,22,1)");
    ctxL.fillStyle = hg; ctxL.fill();
    ctxL.strokeStyle = "rgba(210,205,190,.55)"; ctxL.lineWidth = 1.4;
    ctxL.beginPath(); ctxL.arc(apexX, hcY, ri, 0, Math.PI); ctxL.stroke();
    // struck typebar: the whole arm swings up from its rest angle to the print point (bright, clearly visible)
    if (struck >= 0) {
      const tt = (now - fanStrike.t) / STRIKE_MS;
      if (tt < 1) {
        const aRest = aOf(struck), f = Math.sin(Math.PI * tt);
        const rest = pt(aRest, R), inner = pt(aRest, ri);
        const sx = rest.x + (apexX - rest.x) * f, sy = rest.y + (apexY - rest.y) * f;     // slug rises to the print point
        ctxL.strokeStyle = "rgba(228,224,208,.97)"; ctxL.lineWidth = 2.6;                  // arm
        ctxL.beginPath(); ctxL.moveTo(inner.x, inner.y); ctxL.lineTo(sx, sy); ctxL.stroke();
        ctxL.fillStyle = "#eef1f3"; ctxL.beginPath(); ctxL.arc(sx, sy, 3.6, 0, Math.PI * 2); ctxL.fill();
        if (f > 0.8) { ctxL.fillStyle = `rgba(70,64,56,${(f - 0.8) / 0.2 * 0.55})`; ctxL.beginPath(); ctxL.arc(apexX, apexY, 5, 0, Math.PI * 2); ctxL.fill(); }
      } else fanStrike = null;
    }
    // ribbon at the print point: a single band in the selected ink colour; lifts to meet the slug on a strike
    {
      const liftF = struck >= 0 ? Math.sin(Math.PI * Math.min(1, (now - fanStrike.t) / STRIKE_MS)) : 0;
      const ribY = apexY + 12 - 9 * liftF, rw = Math.min(lidW * 0.5, 320), rh = 9;
      ctxL.fillStyle = `rgb(${inkColor})`;
      rrect(ctxL, apexX - rw / 2, ribY - rh / 2, rw, rh, 3); ctxL.fill();
      ctxL.fillStyle = "rgba(255,255,255,.14)"; ctxL.fillRect(apexX - rw / 2 + 2, ribY - rh / 2 + 1, rw - 4, 1.4);
    }
    ctxL.globalAlpha = 1;
  }

  function frame() {
    const colT = colTarget, yT = rowTop[tw.caret.row] || 0;
    if (reduce) { caretVisCol = colT; caretVisY = yT; relAmt = released ? 1 : 0; }
    else {
      caretVisCol += (colT - caretVisCol) * 0.4; caretVisY += (yT - caretVisY) * 0.32;
      if (Math.abs(colT - caretVisCol) < 0.01) caretVisCol = colT;
      if (Math.abs(yT - caretVisY) < 0.5) caretVisY = yT;
      const rt = released ? 1 : 0; relAmt += (rt - relAmt) * 0.18; if (Math.abs(rt - relAmt) < 0.01) relAmt = rt;
    }
    carriage.style.transform = `translateX(${(-caretVisCol * charW * (1 - relAmt)).toFixed(2)}px)`; // slides while typing
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
      row: res.row, col: res.col, ch: res.char, ink: inkColor,
      jx: (Math.random() - .5) * 1.4, jy: (Math.random() - .5) * 1.4,
      a: .78 + Math.random() * .22, rot: (Math.random() - .5) * .03,
    });
  }
  function emitChar(code) {
    const res = tw.pressKey(code);
    if (res.printed) {
      colTarget = res.col;                                       // this char's slot is at the print point
      addStamp(res);                                             // the char appears where the hammer strikes
      fanStrike = { i: fanIndex.get(code) || 0, t: performance.now() };
      sndKey(); if (res.bell) { flashBell(); sndBell(); }
      const stepTo = res.col + 1, gen = stepGen;
      setTimeout(() => { if (gen === stepGen && stepTo > colTarget) colTarget = stepTo; }, STEP_DELAY); // step after the strike
    }
    else if (res.locked) sndLock();
    if (latch && !physDown) { latch = false; syncShift(); }
    updateStatus();
  }
  function doSpace() { const r = tw.space(); if (r.locked) sndLock(); else { sndKey(); if (r.bell) { flashBell(); sndBell(); } colTarget = tw.caret.col; } updateStatus(); }
  function doBackspace() { if (tw.backspace().moved) { sndBack(); stepGen++; colTarget = tw.caret.col; } updateStatus(); }
  function doCR() { tw.carriageReturn(); stepGen++; colTarget = tw.caret.col; sndCR(); swingLever(); updateStatus(); }
  function doLF() {
    const prev = tw.caret.row; tw.lineFeed(); const r = tw.caret.row;
    if (rowTop[r] == null) rowTop[r] = rowTop[prev] + lineAdvance();   // feed up by the current line-height
    sndLF(); leverFront(); updateStatus();
  }

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
  // bottom px of the lowest content row — used to size the released sheet so all typed lines show
  function contentBottom() {
    let mr = tw.caret.row;
    for (const s of stamps) if (s.row > mr) mr = s.row;
    return rowTop[mr] || 0;
  }
  function toggleRelease() {
    released = !released;
    releaseEl.classList.toggle("pulled", released);
    releaseEl.setAttribute("aria-pressed", String(released));
    document.body.classList.toggle("released", released);
    if (released) {                                                      // present the sheet centred on the screen
      const need = Math.round((FS + 10) + contentBottom() + FS + 12);    // grow to fit all rows (beyond VIS_ROWS)
      setCanvasH(Math.max(pageH, need));
      sheetView.appendChild(paperFrame);
      sheetView.classList.remove("hide");
    } else {                                                            // put it back into the machine
      sheetView.classList.add("hide");
      carriage.insertBefore(paperFrame, releaseEl);
      setCanvasH(pageH);
      positionCarriage();
    }
    sndRelease();
  }
  sheetView.addEventListener("click", () => { if (released) toggleRelease(); });   // click the sheet to put it back

  // ---- lid switches: ribbon colour (right) + line spacing (left). Both are 3-position switches with a "pachi" ----
  const INK = { blue: "58,86,122", black: "43,42,38", red: "150,62,54" };  // muted ink blue / black / muted ink red (r,g,b)
  const switchRepos = [];
  function setupSwitch(id, key, onPick) {
    const el = document.getElementById(id); if (!el) return;
    const knob = el.querySelector(".lh-knob");
    const repos = () => { const a = el.querySelector(".lh.active"); if (a && a.offsetParent) knob.style.top = a.offsetTop + "px"; };
    const pick = (val, click) => {
      el.querySelectorAll(".lh").forEach((b) => b.classList.toggle("active", b.dataset[key] === String(val)));
      repos(); onPick(val); if (click) sndSwitch();   // "pachi" detent click on a flip
    };
    el.querySelectorAll(".lh").forEach((b) => b.addEventListener("click", () => pick(b.dataset[key], true)));
    switchRepos.push(repos);
    return pick;
  }
  setupSwitch("ribbonSwitch", "ink", (v) => { inkColor = INK[v] || INK.black; })("black", false);  // default black ink
  setupSwitch("lineSwitch", "lh", (v) => { lineHeight = parseFloat(v); })("1.5", false);            // default 1.5 spacing
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
  // one cash-register "ching": a clack then a bright inharmonic bell (modelled on レジ ~6674/10510Hz)
  function regChing(t0, gs) {
    burst({ dur: .03, freq: 2600, q: .7, gain: .5 * gs, decay: .035, t: t0 });         // ka — key/drawer clack
    burst({ dur: .015, freq: 700, q: .5, type: "lowpass", gain: .3 * gs, decay: .02, t: t0 });
    const b = t0 + .012;                                                               // ching a hair after the clack
    tone({ freq: 6674, dur: .22, gain: .34 * gs, t: b });                              // bright bell (dominant partial)
    tone({ freq: 10510, dur: .16, gain: .18 * gs, t: b });                             // shimmer partial (sample is bright)
    tone({ freq: 3050, dur: .18, gain: .12 * gs, t: b });                              // body partial
    tone({ freq: 3950, dur: .13, gain: .07 * gs, type: "triangle", t: b });
  }
  // Enter / carriage return — two overlaid chings ("chin-chin")
  function sndCR() { regChing(0, 1); regChing(.08, .82); }
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
  // "パチッ" — crisp toggle-switch detent click (line-height switch)
  function sndSwitch() {
    burst({ dur: .015, freq: 2800, q: 1.2, gain: .55, decay: .016 });                       // snap
    burst({ dur: .02, freq: 850, q: 2, gain: .3, decay: .025, t: .006 });                    // body tick
  }

  // ---- startup ----
  const overlay = document.getElementById("overlay");
  // map each character key to a fan arm by its on-screen x (left key → left arm, right key → right arm)
  function buildFanOrder() {
    const items = fanCodes.map((c) => { const el = keyMap.get(c), r = el && el.getBoundingClientRect(); return { c, x: r ? r.left + r.width / 2 : NaN }; });
    if (items.some((it) => !isFinite(it.x))) return;     // keyboard not laid out yet — keep current order
    items.sort((a, b) => a.x - b.x);
    fanIndex.clear();
    items.forEach((it, i) => fanIndex.set(it.c, i));
  }
  function layoutAll() { layout(); positionCarriage(); layoutLid(); buildFanOrder(); switchRepos.forEach((f) => f()); }
  overlay.addEventListener("click", () => { overlay.classList.add("hide"); const c = ac(); if (c.resume) c.resume(); layoutAll(); updateStatus(); }, { once: true });
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layoutAll, 120); });
  // re-run layout whenever the machine actually gets/changes its size (preview viewport can settle late)
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(layoutAll, 60); }); ro.observe(document.querySelector(".machine")); }
  layoutAll(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);
  requestAnimationFrame(frame);
})();
