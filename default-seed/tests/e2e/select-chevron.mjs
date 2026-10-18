import assert from 'node:assert/strict'

// Base's dropdown rule through a built page: every visible single select drops
// the native look, keeps at least 36px of end padding and draws its chevron
// 10-16px in from the right border, read from the computed background position
// and the select's own box. Returns how many selects it measured.
export async function assertSelectChevron(page, label) {
  const selects = await page.evaluate(() => [...document.querySelectorAll('select')]
    .filter((select) => !select.multiple && !(select.size > 1) && select.getClientRects().length && getComputedStyle(select).visibility !== 'hidden')
    .map((select) => {
      const style = getComputedStyle(select), box = select.getBoundingClientRect()
      const lengths = (value) => [...value.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]))
      const sizes = style.backgroundSize.split(/,\s*/).map((size) => lengths(size)[0] ?? 0)
      // Each layer is `calc(100% - Npx) 50%`: its left edge, so its right gap is the box minus left and width.
      const gaps = style.backgroundPosition.split(/,\s*/).map((position, index) => {
        const offset = lengths(position)[0] ?? 0, width = sizes[index % sizes.length]
        const left = (select.clientWidth - width) - offset
        return box.width - (select.clientLeft + left + width)
      })
      return { name: select.name || select.getAttribute('aria-label') || select.id, appearance: style.appearance, paddingRight: parseFloat(style.paddingRight), image: style.backgroundImage, gap: Math.min(...gaps) }
    }))
  for (const select of selects) {
    const where = `${label}: select ${select.name}`
    assert.equal(select.appearance, 'none', `${where} keeps its native appearance`)
    assert.ok(select.paddingRight >= 36, `${where} has ${select.paddingRight}px of right padding`)
    assert.notEqual(select.image, 'none', `${where} draws no chevron`)
    assert.ok(select.gap >= 10 && select.gap <= 16, `${where} draws its chevron ${select.gap}px from the right edge`)
  }
  return selects.length
}
