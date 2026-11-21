// Renders design/*.svg into the PNG sizes the app, web extension and Safari
// toolbar need. Run: node scripts/render-icons.cjs (uses Playwright's Chromium).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const icon = fs.readFileSync(path.join(root, 'design/icon.svg'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'design/toolbar.svg'), 'utf8');

// macOS icons sit inside a rounded square with margin and a soft shadow.
const macWrap = (svg) => `<div style="width:1024px;height:1024px;display:grid;place-items:center">
  <div style="width:824px;height:824px;border-radius:185px;overflow:hidden;box-shadow:0 10px 24px rgba(0,0,0,.28)">${svg.replace('<svg ', '<svg width="824" height="824" ')}</div></div>`;

async function render(page, html, size, file, transparent) {
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  const buf = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: size, height: size });
  await p2.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/png;base64,${buf.toString('base64')}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
  await p2.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  await p2.close();
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const full = icon.replace('<svg ', '<svg width="1024" height="1024" ');
  const appicon = path.join(root, 'apple/App/Assets.xcassets/AppIcon.appiconset');
  fs.mkdirSync(appicon, { recursive: true });
  await render(page, full, 1024, path.join(appicon, 'ios-1024.png'), false);
  const macSizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of macSizes) await render(page, macWrap(icon), s, path.join(appicon, `mac-${s}.png`), true);
  const images = [{ filename: 'ios-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }];
  for (const [pt, scales] of [[16, [1, 2]], [32, [1, 2]], [128, [1, 2]], [256, [1, 2]], [512, [1, 2]]]) {
    for (const sc of scales) images.push({ filename: `mac-${pt * sc}.png`, idiom: 'mac', scale: `${sc}x`, size: `${pt}x${pt}` });
  }
  fs.writeFileSync(path.join(appicon, 'Contents.json'), JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2));

  const extImages = path.join(root, 'extension/images');
  fs.mkdirSync(extImages, { recursive: true });
  for (const s of [48, 96, 128, 256, 512]) await render(page, macWrap(icon), s, path.join(extImages, `icon-${s}.png`), true);
  const tb = toolbar.replace('<svg ', '<svg width="1024" height="1024" ');
  for (const s of [16, 19, 32, 38]) await render(page, tb, s, path.join(extImages, `toolbar-${s}.png`), true);
  await browser.close();
  console.log('icons rendered');
})();
