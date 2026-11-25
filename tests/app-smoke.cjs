const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  try {
    await page.goto('http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' });

    // First-run risk acknowledgement and home navigation.
    await page.locator('#riskAgree').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#welcomeModal button').filter({ hasText: 'Get started' }).click({ force: true });
    if (await page.locator('#welcomeModal').evaluate(el => el.classList.contains('open'))) {
      throw new Error('Welcome modal did not close after acknowledgement.');
    }

    // All main navigation destinations must become active.
    for (const screen of ['charts', 'learn', 'tools', 'alerts']) {
      await page.locator('nav.bottom button[data-screen="' + screen + '"]').click();
      if (!(await page.locator('#' + screen).evaluate(el => el.classList.contains('active')))) {
        throw new Error('Navigation failed for ' + screen);
      }
    }

    // Chart timeframe control must update the embedded chart URL.
    await page.locator('nav.bottom button[data-screen="charts"]').click();
    await page.locator('#timeframes [data-tf="5"]').click();
    const chartUrl = await page.locator('#mainChart').getAttribute('src');
    if (!chartUrl.includes('interval=5')) throw new Error('Chart timeframe did not update.');

    // Calculators: cent-lot defaults and direction-aware risk/reward.
    await page.locator('nav.bottom button[data-screen="tools"]').click();
    await page.locator('#toolTabs button').filter({ hasText: 'Pip value' }).click();
    await page.locator('#toolPip button').filter({ hasText: 'Calculate' }).click();
    if ((await page.locator('#pipResult').textContent()).trim() !== '$0.01') {
      throw new Error('Pip/move calculator did not return the expected cent-lot estimate.');
    }

    await page.locator('#toolTabs button').filter({ hasText: 'Risk / reward' }).click();
    await page.locator('#toolRr button').filter({ hasText: 'Calculate' }).click();
    if (!(await page.locator('#rrResult').textContent()).includes('2.00:1')) {
      throw new Error('Default BUY risk/reward calculation failed.');
    }
    await page.locator('#rrSide').selectOption('SELL');
    await page.locator('#toolRr button').filter({ hasText: 'Calculate' }).click();
    if (!(await page.locator('#rrResult').textContent()).includes('Check SELL')) {
      throw new Error('Risk/reward accepted invalid SELL stop/target sides.');
    }

    // Saved maximum risk must flow into and constrain position sizing.
    await page.locator('.top button[aria-label="Profile and settings"]').click();
    await page.locator('#maxRisk').fill('0.5');
    await page.locator('#settings button').filter({ hasText: 'Save preferences' }).click();
    await page.locator('nav.bottom button[data-screen="tools"]').click();
    if (await page.locator('#pRisk').inputValue() !== '0.5') {
      throw new Error('Saved maximum risk was not applied to position sizing.');
    }
    await page.locator('#pRisk').fill('1');
    await page.locator('#toolPosition button').filter({ hasText: 'Calculate' }).click();
    if (!(await page.locator('#pResult').textContent()).includes('Above saved max risk')) {
      throw new Error('Position sizing did not enforce the saved maximum risk.');
    }

    // Reminder is deliberately local-only; creation and deletion controls must work.
    await page.locator('nav.bottom button[data-screen="alerts"]').click();
    await page.locator('#alerts button').filter({ hasText: 'Add reminder' }).click();
    await page.locator('#alertLevel').fill('2700');
    await page.locator('#alertExpiry').selectOption({ label: '24 hours' });
    await page.locator('#alertForm button').filter({ hasText: 'Save reminder' }).click();
    if (!(await page.locator('#alertList').textContent()).includes('2700')) {
      throw new Error('Saved reminder did not appear in the reminder list.');
    }
    await page.locator('#alertList button').filter({ hasText: 'Delete' }).click();
    if (!(await page.locator('#alertList').textContent()).includes('No reminders saved')) {
      throw new Error('Reminder deletion failed.');
    }

    // Full-screen chart route must open as a separate page.
    await page.locator('nav.bottom button[data-screen="charts"]').click();
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#charts button').filter({ hasText: 'Open full-screen landscape chart' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    if (!popup.url().includes('gold-chart.html')) throw new Error('Full-screen chart did not open the expected page.');
    await popup.locator('button').filter({ hasText: 'Landscape full screen' }).click();
    if (!(await popup.locator('#hint').textContent()).trim()) throw new Error('Full-screen chart feedback is missing.');

    if (pageErrors.length) throw new Error('Browser JavaScript errors: ' + pageErrors.join(' | '));
    console.log('PASS: mobile navigation, chart timeframe, calculators, max-risk enforcement, reminders, and full-screen chart route.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
