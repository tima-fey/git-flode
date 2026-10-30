// Render the synthetic automation and inspect a card in the disposable HA.
import fs from 'node:fs/promises';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { gotoPanel, inPanel, openBrowser, openFlow, readCards, waitForPanel } = await import(
  '../gate/lib.mjs'
);

const { browser, page, errors } = await openBrowser('chromium');
try {
  await gotoPanel(page);
  errors.length = 0;
  await openFlow(page, 'FLODE test simple automation');
  const cards = await readCards(page);
  if (cards.length !== 2) throw new Error(`Expected trigger and delay cards, got ${cards.length}`);
  await page.locator('.node[data-node-id]').first().click();
  await waitForPanel(page, (panel) => panel.selectedId !== null);
  await page.locator('flode-inspector').waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.mkdir(new URL('./runtime/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('./runtime/panel.png', import.meta.url).pathname });
  console.log(JSON.stringify({ cards: cards.map(({ type, title }) => ({ type, title })), errors }));
  await page.setViewportSize({ width: 390, height: 844 });
  await inPanel(page, (panel) => {
    panel.narrow = true;
  });
  await page.screenshot({ path: new URL('./runtime/panel-mobile.png', import.meta.url).pathname });
  console.log('Desktop and mobile smoke checks passed. Screenshots saved in runtime/.');
} finally {
  await browser.close();
}
