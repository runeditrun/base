// Serialized alongside the probe. Keep this function self-contained. React's
// private fields are observed, never changed; no DOM/Fiber references survive a
// call. See foundation/runtime/hydration/README.md for the supported contract.
export function ownership(snapshot, counted) {
 const unavailable = 'React ownership/current-root information unavailable (verified React 18.2.0–19.3.1, production and development)';
 const own = (el, prefix) => { for (const key of Object.keys(el)) if (key.startsWith(prefix)) return el[key]; };
 try {
  let root = own(document.body, '__reactFiber$');
  if (!root) return { pending: 1, error: unavailable };
  const ancestors = new Set();
  while (root.return) {
   if (ancestors.has(root)) return { pending: 1, error: unavailable };
   ancestors.add(root); root = root.return;
  }
  root = root.stateNode?.current;
  if (root?.tag !== 3 || typeof root.memoizedState?.isDehydrated !== 'boolean') return { pending: 1, error: unavailable };
  let pending = root.memoizedState.isDehydrated ? 1 : 0, bodyOwned = false;
  const owned = new WeakSet(), raw = new WeakSet(), seen = new Set();
  const stack = [[root, root.stateNode.containerInfo, false]];
  while (stack.length) {
   const [node, parent, inBody] = stack.pop();
   if (seen.has(node) || typeof node.tag !== 'number' || !('memoizedState' in node)) return { pending: 1, error: unavailable };
   seen.add(node);
   if (node.memoizedState?.dehydrated) pending++;
   let childParent = parent, childInBody = inBody;
   if (node.tag === 4) { // HostPortal: its container is the host parent, even in a shadow root.
    childParent = node.stateNode?.containerInfo;
    if (!childParent) return { pending: 1, error: unavailable };
    childInBody = true;
   } else if (node.stateNode?.nodeType === 1) {
    const el = node.stateNode;
    childParent = el;
    childInBody = inBody || el === document.body;
    if (childInBody) {
     const attached = own(el, '__reactFiber$'), props = own(el, '__reactProps$');
     if (!attached || !props) return { pending: 1, error: unavailable };
     // The expando can name an older alternate. Only the committed tree's
     // stateNode and host-parent relation establish current ownership.
     if ((attached !== node && attached !== node.alternate) || attached.stateNode !== el || !el.isConnected || el.parentNode !== parent) pending++;
     else {
      owned.add(el);
      if (el === document.body) bodyOwned = true;
      if (node.memoizedProps?.dangerouslySetInnerHTML != null) raw.add(el);
     }
    }
   }
   if (node.sibling) stack.push([node.sibling, parent, inBody]);
   if (node.child) stack.push([node.child, childParent, childInBody]);
  }
  if (!bodyOwned) pending++;
  // Snapshot order is parent before child. Propagate raw-HTML ownership through
  // every parsed descendant, not just the container's direct children. Newly
  // appended imperative widgets never enter this snapshot or this count.
  const rawDescendants = new WeakSet();
  for (const [ref] of snapshot) {
   const el = ref.deref();
   if (!el || !document.body.contains(el) || !counted(el)) continue;
   if (raw.has(el.parentElement) || rawDescendants.has(el.parentElement)) rawDescendants.add(el);
   if (!owned.has(el) && !rawDescendants.has(el)) pending++;
  }
  return { pending, error: null };
 } catch {
  return { pending: 1, error: unavailable };
 }
}
