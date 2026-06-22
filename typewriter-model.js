/*
 * typewriter-model.js — pure state machine for a late-period standard English typewriter.
 *
 * No DOM / canvas / audio: this is the testable logic core (see test/typewriter-model.test.js).
 * Mechanism reference: docs/typewriter-mechanism.md
 *
 * Works both as a CommonJS module (Node tests) and as a classic browser <script>
 * (exposes window.createTypewriter / window.LAYOUT).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.TypewriterModel = api;
    root.createTypewriter = api.createTypewriter;
    root.LAYOUT = api.LAYOUT;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A letter key: KeyboardEvent.code -> { lower, UPPER }.
  const L = (c) => ({ code: "Key" + c.toUpperCase(), lo: c, up: c.toUpperCase() });

  // Standard 4-row board. `lo` = rest glyph, `up` = single-SHIFT glyph.
  // Symbol pairings are a sensible ASCII default for a late standard machine;
  // edit here to match a specific model (this is the single source of truth).
  const LAYOUT = {
    cols: 62,
    rows: [
      [
        { code: "Digit1", lo: "1", up: "!" },
        { code: "Digit2", lo: "2", up: '"' },
        { code: "Digit3", lo: "3", up: "#" },
        { code: "Digit4", lo: "4", up: "$" },
        { code: "Digit5", lo: "5", up: "%" },
        { code: "Digit6", lo: "6", up: "_" },
        { code: "Digit7", lo: "7", up: "&" },
        { code: "Digit8", lo: "8", up: "'" },
        { code: "Digit9", lo: "9", up: "(" },
        { code: "Digit0", lo: "0", up: ")" },
      ],
      "qwertyuiop".split("").map(L),
      "asdfghjkl".split("").map(L).concat([
        { code: "Semicolon", lo: ";", up: ":" },
        { code: "Quote", lo: "'", up: '"' },
      ]),
      "zxcvbnm".split("").map(L).concat([
        { code: "Comma", lo: ",", up: "<" },
        { code: "Period", lo: ".", up: ">" },
        { code: "Slash", lo: "/", up: "?" },
      ]),
    ],
  };

  function createTypewriter(config = {}) {
    const cols = config.cols != null ? config.cols : LAYOUT.cols;
    const leftMargin = config.leftMargin != null ? config.leftMargin : 0;
    const bellCol = config.bellCol != null ? config.bellCol : cols - 8;
    const cfg = { cols, leftMargin, bellCol };

    // grid[row][col] = array of stamped characters (array allows overstrike).
    const grid = [];
    const caret = { row: 0, col: leftMargin };
    let physShift = false; // SHIFT held
    let shiftLock = false; // SHIFT LOCK latched
    let bellArmed = true;

    const keyByCode = new Map();
    LAYOUT.rows.flat().forEach((k) => keyByCode.set(k.code, k));

    const shiftActive = () => physShift || shiftLock;

    function ensureRow(r) {
      while (grid.length <= r) grid.push([]);
    }
    function charsAt(r, c) {
      return (grid[r] && grid[r][c]) || [];
    }

    // Advance the carriage one column, honouring the right-margin lock and bell.
    // Returns { advanced, locked, bell }.
    function advance() {
      if (caret.col >= cfg.cols) return { advanced: false, locked: true, bell: false };
      caret.col += 1;
      let bell = false;
      if (bellArmed && caret.col === cfg.bellCol) {
        bell = true;
        bellArmed = false;
      }
      return { advanced: true, locked: false, bell };
    }

    function pressKey(code) {
      const key = keyByCode.get(code);
      if (!key) return { printed: false, ignored: true };
      if (caret.col >= cfg.cols) return { printed: false, locked: true };

      const char = shiftActive() ? key.up : key.lo;
      const row = caret.row;
      const col = caret.col;
      ensureRow(row);
      if (!grid[row][col]) grid[row][col] = [];
      grid[row][col].push(char);

      const adv = advance();
      return { printed: true, char, row, col, bell: adv.bell, locked: false };
    }

    function space() {
      return advance();
    }

    function backspace() {
      if (caret.col > cfg.leftMargin) {
        caret.col -= 1;
        return { moved: true };
      }
      return { moved: false };
    }

    function carriageReturn() {
      caret.col = cfg.leftMargin;
      bellArmed = true;
      return {};
    }

    function lineFeed() {
      caret.row += 1;
      ensureRow(caret.row);
      return {};
    }

    return {
      config: cfg,
      cols,
      leftMargin,
      bellCol,
      caret,
      charsAt,
      pressKey,
      space,
      backspace,
      carriageReturn,
      lineFeed,
      setShiftHeld(b) { physShift = !!b; },
      toggleShiftLock() { shiftLock = !shiftLock; return shiftLock; },
      isShiftLocked() { return shiftLock; },
      isShiftHeld() { return physShift; },
      isShiftActive() { return shiftActive(); },
      releaseAll() { physShift = false; },
    };
  }

  return { createTypewriter, LAYOUT };
});
