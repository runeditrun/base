// Serialized into demo HTML, with its exact text allowed by CSP. Fixed chrome
// ignores document padding; offset viewport-anchored chrome without seed edits.
function reserveDemoSpace() {
  const root = document.documentElement;
  const bar = document.getElementById('rer-demo-bar');
  const changed = new Map();
  let frame;
  const observer = new MutationObserver(schedule);
  const observe = () => observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  function set(element, property, value) {
    const style = element.style;
    const saved = changed.get(element) ?? [];
    saved.push([property, style.getPropertyValue(property), style.getPropertyPriority(property), value]);
    changed.set(element, saved);
    style.setProperty(property, value, 'important');
  }
  function viewportAnchored(element, position) {
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (position === 'sticky' && parent !== document.body && /(auto|scroll|hidden|clip)/.test(style.overflowY)) return false;
      if (position === 'fixed' && (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' || /layout|paint|strict|content/.test(style.contain) || /transform|perspective|filter/.test(style.willChange))) return false;
    }
    return true;
  }
  function update() {
    frame = undefined;
    observer.disconnect();
    // Restore only our writes: a route or responsive shell may have replaced
    // an inline style since the previous pass.
    for (const [element, properties] of changed) for (const [property, value, priority, ours] of properties) {
      if (element.style.getPropertyValue(property) === ours) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
    }
    changed.clear();
    if (!bar.isConnected) return;
    const height = bar.getBoundingClientRect().height;
    const property = '--rer-demo-bar-height';
    const value = root.style.getPropertyValue(property), priority = root.style.getPropertyPriority(property);
    root.style.setProperty(property, '0px', 'important');
    const candidates = [];
    for (const element of document.body.querySelectorAll('*')) {
      if (bar.contains(element)) continue;
      const style = getComputedStyle(element), top = parseFloat(style.top);
      if (['fixed', 'sticky'].includes(style.position) && Number.isFinite(top) && top >= 0 && viewportAnchored(element, style.position)) {
        candidates.push({ element, top, position: style.position });
      }
    }
    if (value) root.style.setProperty(property, value, priority);
    else root.style.removeProperty(property);
    // Read before writing so nested sticky elements keep their own geometry.
    const offsets = candidates.map(candidate => {
      const style = getComputedStyle(candidate.element);
      return { ...candidate, currentTop: parseFloat(style.top), height: parseFloat(style.height), maxHeight: style.maxHeight };
    });
    for (const item of offsets) {
      // A seed that already uses the public variable must not move twice.
      const usesVariable = Math.abs(item.currentTop - item.top) > 0.5;
      const top = usesVariable ? item.currentTop : item.top + height;
      if (!usesVariable) set(item.element, 'top', `calc(${item.top}px + var(--rer-demo-bar-height))`);
      if (item.position === 'fixed' && item.height > innerHeight - top) {
        const available = `calc(100dvh - ${top}px)`;
        set(item.element, 'max-height', item.maxHeight === 'none' ? available : `min(${item.maxHeight}, ${available})`);
      }
    }
    observe();
  }
  addEventListener('resize', schedule);
  addEventListener('focusin', schedule);
  document.addEventListener('toggle', schedule, true);
  document.addEventListener('DOMContentLoaded', update, { once: true });
  update();
}

export const LAYOUT_SCRIPT = `(${reserveDemoSpace.toString()})();`;
