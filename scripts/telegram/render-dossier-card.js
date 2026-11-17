// Рендерится только локальный HTML: внешние ресурсы и JS для карточки не нужны.
async function renderDossierCard(html, launchOptions = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, timeout: 15000, ...launchOptions });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 600 }, deviceScaleFactor: 1, javaScriptEnabled: false });
    page.setDefaultTimeout(15000);
    await page.route('**/*', route => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const size = await page.locator('body').boundingBox();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (!size || scrollWidth > 1080 || size.height > 6000) throw new Error('Карточка превышает допустимый размер');
    return await page.locator('body').screenshot({ type: 'png', timeout: 15000 });
  } finally {
    await browser.close();
  }
}
module.exports = { renderDossierCard };
