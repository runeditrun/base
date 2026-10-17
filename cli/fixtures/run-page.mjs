// The built Run page's command blocks, measured in the browser: the command text
// the reader must be able to read, and the Copy button laid over the block.
export const commandBlocks = page => page.evaluate(() => [...document.querySelectorAll('.code')].map(block => {
  const button = block.querySelector('.copy').getBoundingClientRect(), pre = block.querySelector('pre').getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(block.querySelector('pre code'));
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  const over = rect => rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top;
  return { command: block.querySelector('pre code').textContent, covered: rects.some(over), clipped: rects.some(rect => rect.right > pre.right + 0.5 || rect.left < pre.left - 0.5) };
}));

/** Opens the Run page at `width` and returns the commands the Copy button covers or the block clips. */
export async function unreadableCommands(browser, url, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(url);
    const blocks = await commandBlocks(page);
    if (blocks.length < 2) throw new Error(`The Run page shows ${blocks.length} command blocks; it has the install line and the start line.`);
    return blocks.filter(block => block.covered || block.clipped).map(block => block.command);
  } finally { await context.close(); }
}
