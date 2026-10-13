export async function settle(page, { timeoutMs = 10_000 } = {}) {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  await page.evaluate(async timeout => {
    let timer;
    try {
      await Promise.race([
        (async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fonts or animation frames did not settle')), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }, timeoutMs);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: timeoutMs });
  await page.evaluate(async timeout => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity && animation.playState !== 'finished');
    let timer;
    try {
      await Promise.race([
        Promise.all(animations.map(animation => animation.finished.catch(() => {}))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Finite animations did not finish')), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, timeoutMs);
}

export async function keyboardCheck(page, { keyboard = true, keyboardReason } = {}) {
  if (!keyboard) {
    if (!keyboardReason?.trim()) throw new TypeError('Disabling keyboard requires keyboardReason');
    return { enabled: false, passed: true, reason: keyboardReason };
  }
  await page.evaluate(() => {
    const previous = document.body.getAttribute('tabindex');
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    if (previous === null) document.body.removeAttribute('tabindex');
    else document.body.setAttribute('tabindex', previous);
  });
  await page.keyboard.press('Tab');
  return { enabled: true, passed: await page.evaluate(() => {
    const active = document.activeElement;
    return active !== document.body && active !== document.documentElement && active?.matches(':focus-visible') === true;
  }) };
}
