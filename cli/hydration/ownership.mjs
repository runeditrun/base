// Serialized alongside the probe. Keep this function self-contained. React's
// private fields are observed, never changed; only weak boundary identities
// survive a call. See foundation/runtime/hydration/README.md for the supported contract.
export function ownership(snapshot, counted, serverBoundaries) {
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
  if (root?.tag !== 3 || !root.stateNode?.containerInfo || typeof root.memoizedState?.isDehydrated !== 'boolean') return { pending: 1, error: unavailable };
  let pending = root.memoizedState.isDehydrated ? 1 : 0, bodyOwned = false;
  const owned = new WeakSet(), raw = new WeakSet(), seen = new Set();
  const stack = [[root, root.stateNode.containerInfo, false]];
  while (stack.length) {
   const [node, parent, inBody] = stack.pop();
   if (seen.has(node) || typeof node.tag !== 'number' || !('memoizedState' in node) || !('child' in node) || !('sibling' in node)) return { pending: 1, error: unavailable };
   seen.add(node);
   // Track server provenance across the current/alternate pair. A server
   // boundary can abandon hydration for a client fallback; a boundary first
   // created on the client has no dehydration history and cannot block hydration.
   if (node.tag === 13 || node.tag === 31) {
    if (node.memoizedState === null) {
     // Once hydration completed, a later client suspension cannot reopen it.
     serverBoundaries.delete(node);
     if (node.alternate) serverBoundaries.delete(node.alternate);
    } else if (node.memoizedState?.dehydrated || node.alternate?.memoizedState?.dehydrated) {
     serverBoundaries.add(node);
     if (node.alternate) serverBoundaries.add(node.alternate);
    }
    if (serverBoundaries.has(node) || (node.alternate && serverBoundaries.has(node.alternate))) {
     serverBoundaries.add(node);
     if (node.alternate) serverBoundaries.add(node.alternate);
     if (node.memoizedState !== null) pending++;
    }
   }
   let childParent = parent, childInBody = inBody;
   if (node.tag === 4) { // HostPortal: its container is the host parent, even in a shadow root.
    childParent = node.stateNode?.containerInfo;
    if (!childParent) return { pending: 1, error: unavailable };
    childInBody = true;
   } else if (node.tag === 26) { // HostHoistable: metadata and shared resources.
    // Hydrated metadata deliberately lacks a props attachment; resources can
    // lack both attachments. The committed Fiber/resource identifies the node.
    // Resource updates can leave stateNode pointing to the previous resource.
    const resource = node.memoizedState;
    const el = resource === null ? node.stateNode : resource?.instance;
    if ((!el || el.nodeType !== 1) && resource?.type !== 'void') pending++;
    else if (el?.isConnected) {
     const container = parent?.getRootNode(), hoistableRoot = container?.nodeType === 11 ? container : el.ownerDocument.head;
     if (el.parentNode !== hoistableRoot) pending++;
     else owned.add(el);
    }
   } else if (node.stateNode?.nodeType === 1) {
    const el = node.stateNode;
    childParent = el;
    childInBody = inBody || el === document.body;
    // A committed host identity establishes that React adopted/created it.
    // Its later removal does not undo hydration (including a second root
    // clearing adopted children). Connected stale moves still fail below.
    if (childInBody && el.isConnected) {
     const attached = own(el, '__reactFiber$'), props = own(el, '__reactProps$');
     if (!attached || !props) return { pending: 1, error: unavailable };
     // The expando can name an older alternate. Only the committed tree's
     // stateNode and host-parent relation establish current ownership.
     if ((attached !== node && attached !== node.alternate) || attached.stateNode !== el || el.parentNode !== parent) pending++;
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
