'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTypewriter, LAYOUT } = require('../typewriter-model.js');

// ---- layout (single source of truth for the standard 4-row board) ----

test('LAYOUT is a 4-row standard board; letters and number row carry two glyphs', () => {
  assert.ok(Array.isArray(LAYOUT.rows));
  assert.strictEqual(LAYOUT.rows.length, 4);
  const flat = LAYOUT.rows.flat();
  const q = flat.find(k => k.code === 'KeyQ');
  assert.ok(q && q.lo === 'q' && q.up === 'Q', 'KeyQ should be q/Q');
  const d2 = flat.find(k => k.code === 'Digit2');
  assert.ok(d2 && d2.lo === '2' && d2.up !== '2', 'Digit2 shift must be a symbol, not 2');
});

// ---- typing & escapement (horizontal advance) ----

test('starts with the caret at row 0, col 0', () => {
  const tw = createTypewriter();
  assert.strictEqual(tw.caret.row, 0);
  assert.strictEqual(tw.caret.col, 0);
});

test('typing a letter prints it at the caret and advances one column', () => {
  const tw = createTypewriter();
  const r = tw.pressKey('KeyH');
  assert.strictEqual(r.printed, true);
  assert.strictEqual(r.char, 'h');
  assert.deepStrictEqual(tw.charsAt(0, 0), ['h']);
  assert.strictEqual(tw.caret.col, 1);
  assert.strictEqual(tw.caret.row, 0);
});

test('successive letters fill successive columns left to right', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyH');
  tw.pressKey('KeyI');
  assert.deepStrictEqual(tw.charsAt(0, 0), ['h']);
  assert.deepStrictEqual(tw.charsAt(0, 1), ['i']);
  assert.strictEqual(tw.caret.col, 2);
});

test('pressing a key with no character mapping is ignored', () => {
  const tw = createTypewriter();
  const r = tw.pressKey('F1');
  assert.strictEqual(r.printed, false);
  assert.strictEqual(tw.caret.col, 0);
});

// ---- single SHIFT: upper glyph for ALL keys ----

test('holding shift selects the capital letter', () => {
  const tw = createTypewriter();
  tw.setShiftHeld(true);
  const r = tw.pressKey('KeyA');
  assert.strictEqual(r.char, 'A');
  assert.deepStrictEqual(tw.charsAt(0, 0), ['A']);
});

test('the same single shift also gives the symbol on the number row', () => {
  const tw = createTypewriter();
  tw.setShiftHeld(true);
  assert.strictEqual(tw.pressKey('Digit2').char, '"');
});

test('releasing shift returns to the lower glyph', () => {
  const tw = createTypewriter();
  tw.setShiftHeld(true);
  tw.setShiftHeld(false);
  assert.strictEqual(tw.pressKey('KeyA').char, 'a');
});

// ---- SHIFT LOCK: latches, and affects ALL keys (not letters-only like Caps Lock) ----

test('shift lock latches the upper glyph for letters AND the number row until toggled off', () => {
  const tw = createTypewriter();
  tw.toggleShiftLock();
  assert.strictEqual(tw.isShiftActive(), true);
  assert.strictEqual(tw.pressKey('KeyA').char, 'A');   // letter -> capital
  assert.strictEqual(tw.pressKey('Digit3').char, '#'); // number row -> symbol
  tw.toggleShiftLock();
  assert.strictEqual(tw.isShiftActive(), false);
  assert.strictEqual(tw.pressKey('KeyA').char, 'a');
});

// ---- space ----

test('space advances the column without printing anything', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyA');
  tw.space();
  tw.pressKey('KeyB');
  assert.deepStrictEqual(tw.charsAt(0, 0), ['a']);
  assert.deepStrictEqual(tw.charsAt(0, 1), []);
  assert.deepStrictEqual(tw.charsAt(0, 2), ['b']);
  assert.strictEqual(tw.caret.col, 3);
});

// ---- backspace: repositions only, never erases ----

test('backspace moves left one column without erasing', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyA');
  const r = tw.backspace();
  assert.strictEqual(r.moved, true);
  assert.strictEqual(tw.caret.col, 0);
  assert.deepStrictEqual(tw.charsAt(0, 0), ['a']);
});

test('backspace does not move past the left margin', () => {
  const tw = createTypewriter();
  const r = tw.backspace();
  assert.strictEqual(r.moved, false);
  assert.strictEqual(tw.caret.col, 0);
});

test('backspace then type overstrikes the same cell (no erase)', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyO');
  tw.backspace();
  tw.pressKey('Slash');
  assert.deepStrictEqual(tw.charsAt(0, 0), ['o', '/']);
});

// ---- CR and LF are separate ----

test('carriage return resets the column only, never the row', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyA');
  tw.pressKey('KeyB');
  tw.carriageReturn();
  assert.strictEqual(tw.caret.col, 0);
  assert.strictEqual(tw.caret.row, 0);
});

test('line feed advances the row only, never the column', () => {
  const tw = createTypewriter();
  tw.pressKey('KeyA');
  tw.pressKey('KeyB');
  tw.lineFeed();
  assert.strictEqual(tw.caret.row, 1);
  assert.strictEqual(tw.caret.col, 2);
});

// ---- right margin lock ----

test('locks at the right margin and refuses further typing', () => {
  const tw = createTypewriter({ cols: 3 });
  tw.pressKey('KeyA');
  tw.pressKey('KeyB');
  tw.pressKey('KeyC');
  const r = tw.pressKey('KeyD');
  assert.strictEqual(r.printed, false);
  assert.strictEqual(r.locked, true);
  assert.strictEqual(tw.caret.col, 3);
  assert.deepStrictEqual(tw.charsAt(0, 3), []);
});

test('space is also blocked at the right margin', () => {
  const tw = createTypewriter({ cols: 1 });
  tw.pressKey('KeyA');
  const r = tw.space();
  assert.strictEqual(r.locked, true);
  assert.strictEqual(tw.caret.col, 1);
});

// ---- margin bell ----

test('the bell rings once when the carriage reaches the bell column, re-armed by CR', () => {
  const tw = createTypewriter({ cols: 12, bellCol: 3 });
  assert.strictEqual(!!tw.pressKey('KeyA').bell, false); // -> col 1
  assert.strictEqual(!!tw.pressKey('KeyA').bell, false); // -> col 2
  assert.strictEqual(tw.pressKey('KeyA').bell, true);    // -> col 3 == bellCol
  assert.strictEqual(!!tw.pressKey('KeyA').bell, false); // -> col 4, no repeat
  tw.carriageReturn();
  assert.strictEqual(!!tw.pressKey('KeyA').bell, false); // -> col 1
  assert.strictEqual(!!tw.pressKey('KeyA').bell, false); // -> col 2
  assert.strictEqual(tw.pressKey('KeyA').bell, true);    // -> col 3 again
});
