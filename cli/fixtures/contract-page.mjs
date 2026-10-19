// Measure the split card's text elements, without counting their containing
// paragraphs twice. Inline elements may have one rectangle per wrapped line.
export const splitCardLayout = page => page.locator('.card.split').evaluate(card => {
  const bounds = card.getBoundingClientRect(), overlaps = [], overflow = [];
  const elements = [...card.querySelectorAll('h2, .line > span, .none, .of-n')];
  const boxes = elements.flatMap((element, index) =>
    [...element.getClientRects()].filter(rect => rect.width && rect.height).map(rect => ({
      index, text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    })));
  const textBoxes = elements.flatMap((element, index) => {
    const range = document.createRange(); range.selectNodeContents(element);
    return [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => ({
      index, text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    }));
  });
  for (const a of [...boxes, ...textBoxes]) {
    if (a.left < bounds.left - 0.5 || a.right > bounds.right + 0.5 || a.left < -0.5 || a.right > innerWidth + 0.5) overflow.push(a);
  }
  for (const [index, a] of textBoxes.entries()) {
    for (const b of textBoxes.slice(index + 1)) {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left), height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (a.index !== b.index && width > 0.5 && height > 0.5) overlaps.push({ a, b, width, height });
    }
  }
  return { boxes, textBoxes, overlaps, overflow, sideways: card.scrollWidth > card.clientWidth + 0.5,
    pageSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 0.5 };
});
