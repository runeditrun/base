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

// The header's site links as a phone shows them. A seed with /docs carries a
// third link, so add the one the default seed lacks. Reports sideways page
// overflow and any link that is off screen, under 24px, or over another link
// or the mark.
export const headerLayout = async page => {
  await page.locator('.bar nav').evaluate(nav => { if (!nav.querySelector('[href="/docs"]')) nav.insertAdjacentHTML('afterbegin', '<a href="/docs">Docs</a>'); });
  return page.evaluate(() => {
    const root = document.documentElement, mark = document.querySelector('.bar .brand').getBoundingClientRect();
    const links = [...document.querySelectorAll('.bar nav a')].map(link => ({ text: link.textContent, rect: link.getBoundingClientRect() }));
    const meets = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    return {
      sideways: root.scrollWidth > root.clientWidth + 0.5,
      links: links.length,
      offscreen: links.filter(({ rect }) => rect.left < -0.5 || rect.right > root.clientWidth + 0.5).map(link => link.text),
      small: links.filter(({ rect }) => rect.width < 24 || rect.height < 24).map(link => link.text),
      overlaps: links.flatMap((a, index) => [...links.slice(index + 1).filter(b => meets(a.rect, b.rect)).map(b => `${a.text}/${b.text}`), ...(meets(a.rect, mark) ? [`${a.text}/mark`] : [])]),
    };
  });
};
