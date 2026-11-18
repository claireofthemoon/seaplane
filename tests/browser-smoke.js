// Browser smoke test against the fake Seaboard. Needs Playwright.
// Usage: node tests/browser-smoke.js [screenshot.png]
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  await p.addInitScript({ path: path.join(__dirname, 'fake-seaboard.js') });
  await p.goto('file://' + path.join(__dirname, '..', 'index.html'));
  if (process.argv[3]) await p.screenshot({ path: process.argv[3] });
  await p.click('#btn-power');
  await p.waitForSelector('#rack:not([hidden])', { timeout: 5000 });
  const cfg = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__config)));
  const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) process.exitCode = 1; };

  check('status says connected', /connected/i.test(await p.textContent('#status')));
  check('device strip shows firmware', /M1\.4\.3/.test(await p.textContent('#device-strip')));

  // Toggle: piano mode
  await p.click('[data-item="17"] .switch-btn');
  await p.waitForTimeout(900);
  check('piano mode written', (await cfg())[17][0] === 1);
  check('piano mode shows saved/changed', await p.$eval('[data-item="17"]', e => e.classList.contains('changed')));

  // Knob: drag glide sensitivity up to the top
  const k = await p.$('[data-item="11"] .knob');
  const box = await k.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2, box.y - 150, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(900);
  check('knob drag wrote 127 once', (await cfg())[11][0] === 127 &&
    (await p.evaluate(() => window.__sets.filter(s => s[0] === 11).length)) === 1);
  check('knob readout', (await p.textContent('[data-item="11"] .readout')) === '127');

  // Knob keyboard: bend range down 2
  await p.focus('[data-item="3"] .knob');
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(1200);
  check('bend range via keys = 46', (await cfg())[3][0] === 46);

  // Stepper: octave down to -1 (negative value)
  await p.click('[data-item="4"] .stepper button:first-child');
  await p.waitForTimeout(1200);
  check('octave -1 written', (await cfg())[4][0] === -1);
  check('octave readout', (await p.textContent('[data-item="4"] .readout')) === '-1');

  // Segments: MIDI mode -> Single Channel
  await p.click('[data-item="2"] .segments button:nth-child(3)');
  await p.waitForTimeout(900);
  check('MIDI mode = 2', (await cfg())[2][0] === 2);

  // Double-click glide rate knob -> factory default (0, no change) then glide sens back to 100
  await p.dblclick('[data-item="11"] .knob');
  await p.waitForTimeout(900);
  check('double-click resets glide to factory 100', (await cfg())[11][0] === 100);

  if (process.argv[2]) await p.screenshot({ path: process.argv[2], fullPage: true });

  await p.click('#btn-undo');
  await p.waitForTimeout(1200);
  const c = await cfg();
  check('revert restores originals', c[17][0] === 0 && c[11][0] === 102 && c[3][0] === 48 && c[4][0] === 0 && c[2][0] === 1);
  check('revert button disabled after', await p.isDisabled('#btn-undo'));

  await p.click('#btn-power');
  check('disconnect sends endAPIMode', (await p.evaluate(() => window.__sent.slice(-1)[0])) === 'F0 00 21 10 77 17 01 02 00 60 F7');
  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors);
  await b.close();
})();
