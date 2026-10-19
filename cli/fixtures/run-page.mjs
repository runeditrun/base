// A seed can give the shared page a wider wordmark, navigation and terminal
// font, as Chest does. Exercise that adoption through the built site too.
export const runLayoutTheme = `
:root { --rer-font-body: Arial, sans-serif; --rer-font-heading: Arial, sans-serif; }
body:has(> header.bar) > .bar { padding: 22px clamp(16px, 5.73vw, 88px) 0; }
body:has(> header.bar) > .bar .brand { gap: 12px; font-weight: 750; letter-spacing: -.035em; }
body:has(> header.bar) > .bar nav a { font-size: 20px; font-weight: 450; }
body:has(> header.bar) .code pre { font-size: 15.5px; }
@media (max-width: 760px) { body:has(> header.bar) .code pre { font-size: 13px; } }
`;

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

// The Linen sweep's code-chip-breaks-word check: measure characters across text
// nodes, so a line may start after whitespace but never inside a word or path.
export const codeChipBreaksWord = page => page.evaluate(() => {
  const breaks = [];
  for (const code of document.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let previous = null, previousTop = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent.length; i++) {
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0], character = node.textContent[i];
        if (!rect || rect.width === 0 || /\s/.test(character)) { previous = character; continue; }
        if (previousTop !== null && rect.top > previousTop + 2 && !/\s/.test(previous ?? ' ')) {
          breaks.push({ kind: 'code-chip-breaks-word', code: code.textContent, before: node.textContent.slice(i, i + 10) });
        }
        previousTop = rect.top; previous = character;
      }
    }
  }
  return breaks;
});

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
