const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  const pageErrors = [];
  let alerts = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  // Keep CI deterministic: simulate a verified Firebase session and the alert API.
  const firebaseStub = `
    (() => {
      const user = { email: 'smoke@example.com', emailVerified: true, getIdToken: async () => 'mock-firebase-id-token', reload: async () => {} };
      const auth = {
        currentUser: user,
        setPersistence: async () => {},
        onAuthStateChanged: callback => { setTimeout(() => callback(user), 0); },
        getRedirectResult: async () => null,
        signOut: async () => {},
        signInWithPopup: async () => ({ user }),
        signInWithRedirect: async () => {},
        signInWithEmailAndPassword: async () => ({ user }),
        createUserWithEmailAndPassword: async () => ({ user }),
        sendPasswordResetEmail: async () => {},
      };
      function authFactory() { return auth; }
      authFactory.Auth = { Persistence: { LOCAL: 'local' } };
      authFactory.GoogleAuthProvider = function GoogleAuthProvider() {};
      window.firebase = { initializeApp() {}, auth: authFactory };
    })();
  `;
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  await page.route('https://ngr-gold-alerts.kumail551255.workers.dev/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/health') return route.fulfill({ json: { status: 'online', monitorIntervalSeconds: 60 } });
    if (url.pathname === '/claim-device') return route.fulfill({ json: { success: true, migrated: 0, activeAlerts: alerts.length } });
    if (url.pathname === '/price') return route.fulfill({ json: { price: 2650, updatedAt: new Date().toISOString() } });
    if (url.pathname === '/alerts' && request.method() === 'GET') return route.fulfill({ json: { alerts } });
    if (url.pathname === '/alerts' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const alert = { id: '00000000-0000-4000-8000-000000000001', condition: body.condition, level: body.level, expiry: body.expiry, createdAt: Date.now() };
      alerts.push(alert);
      return route.fulfill({ status: 201, json: { success: true, alert } });
    }
    if (url.pathname === '/alerts' && request.method() === 'DELETE') {
      alerts = alerts.filter(item => item.id !== url.searchParams.get('id'));
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === '/test-notification') return route.fulfill({ json: { success: true, acceptedByNtfy: true } });
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });

  try {
    await page.goto('http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('authenticated'));
    if (!(await page.locator('#authGate').evaluate(el => el.classList.contains('hide')))) {
      throw new Error('Verified Firebase session did not unlock the app.');
    }

    // First-run risk acknowledgement and home navigation.
    await page.locator('#riskAgree').check();
    await page.locator('#welcomeModal button').filter({ hasText: 'Get started' }).click();
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
    if (!(await page.locator('#rrResult').textContent()).includes('2.00:1')) throw new Error('Default BUY risk/reward calculation failed.');
    await page.locator('#rrSide').selectOption('SELL');
    await page.locator('#toolRr button').filter({ hasText: 'Calculate' }).click();
    if (!(await page.locator('#rrResult').textContent()).includes('Check SELL')) throw new Error('Risk/reward accepted invalid SELL stop/target sides.');

    // Saved maximum risk must flow into and constrain position sizing.
    await page.locator('.top button[aria-label="Profile and settings"]').click();
    await page.locator('#maxRisk').fill('0.5');
    await page.locator('#settings button').filter({ hasText: 'Save preferences' }).click();
    await page.locator('nav.bottom button[data-screen="tools"]').click();
    if (await page.locator('#pRisk').inputValue() !== '0.5') throw new Error('Saved maximum risk was not applied to position sizing.');
    await page.locator('#pRisk').fill('1');
    await page.locator('#toolPosition button').filter({ hasText: 'Calculate' }).click();
    if (!(await page.locator('#pResult').textContent()).includes('Above saved max risk')) throw new Error('Position sizing did not enforce the saved maximum risk.');

    // Authenticated cloud alert creation and deletion.
    await page.locator('nav.bottom button[data-screen="alerts"]').click();
    await page.locator('#ntfyTopic').fill('NGRSmokeTopic2026');
    await page.locator('#alerts button').filter({ hasText: 'Save topic' }).click();
    await page.locator('#alerts button').filter({ hasText: 'Add alert' }).click();
    await page.locator('#alertLevel').fill('2700');
    await page.locator('#alertExpiry').selectOption({ label: '24 hours' });
    await page.locator('#alertForm button').filter({ hasText: 'Create cloud alert' }).click();
    if (!(await page.locator('#alertList').textContent()).includes('2700')) throw new Error('Cloud alert did not appear in the list.');
    await page.locator('#alertList button').filter({ hasText: 'Delete' }).click();
    if (!(await page.locator('#alertList').textContent()).includes('No active alerts')) throw new Error('Cloud alert deletion failed.');

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
    console.log('PASS: Firebase session gate, navigation, chart timeframe, calculators, max-risk enforcement, cloud alerts, and full-screen chart route.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
