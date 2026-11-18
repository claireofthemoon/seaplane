// Browser smoke test against the fake Seaboard. Needs Playwright: node tests/browser-smoke.js [screenshot.png]
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript({ path: require('path').join(__dirname, 'fake-seaboard.js') });
  await p.goto('file://' + require('path').join(__dirname, '..', 'index.html'));
  await p.click('#btn-connect');
  await p.waitForTimeout(1500);
  console.log('status:', await p.textContent('#status'), '|', await p.textContent('#device-line'));
  console.log('pitch rows:', await p.$$eval('#group-pitch .setting .name', e => e.map(x => x.textContent)));
  await p.click('#group-pitch .setting:first-child .switch input', { force: true });
  await p.waitForTimeout(150);
  console.log('state while sending:', await p.textContent('#group-pitch .setting:first-child .state'));
  await p.waitForTimeout(800);
  console.log('state after:', await p.textContent('#group-pitch .setting:first-child .state'), 'fake config 17 =', await p.evaluate(() => window.__config[17][0]));
  // slider: glide sensitivity
  await p.fill('#group-pitch .setting:nth-child(4) input[type=number]', '0');
  await p.press('#group-pitch .setting:nth-child(4) input[type=number]', 'Enter');
  await p.waitForTimeout(1000);
  console.log('glide sens on fake =', await p.evaluate(() => window.__config[11][0]), 'undo enabled:', !(await p.isDisabled('#btn-undo')));
  await p.screenshot({ path: process.argv[2] || 'seaplane-smoke.png', fullPage: true });
  await p.click('#btn-undo');
  await p.waitForTimeout(1000);
  console.log('after undo 17 =', await p.evaluate(() => window.__config[17][0]), '11 =', await p.evaluate(() => window.__config[11][0]), 'undo enabled:', !(await p.isDisabled('#btn-undo')));
  console.log('pings to 23:', await p.evaluate(() => window.__sent.filter(s => s === 'F0 00 21 10 77 17 01 03 00 63 F7').length));
  console.log('errors:', errors);
  await b.close();
})();
