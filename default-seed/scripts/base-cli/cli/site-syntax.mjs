// Shared ESTree helpers. Walk actual syntax so comments, string delimiters and
// formatting do not change which values the site checks.
export function walkSyntax(node, visit, parents = []) {
 if (!node || typeof node !== 'object' || !node.type) return;
 visit(node, parents);
 for (const value of Object.values(node)) {
  if (Array.isArray(value)) for (const child of value) walkSyntax(child, visit, [...parents, node]);
  else if (value?.type) walkSyntax(value, visit, [...parents, node]);
 }
}
export const memberName = node => node?.type === 'MemberExpression' ? node.computed ? stringValue(node.property) : node.property.name : undefined;
export const stringValue = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
export function javascriptStrings(tree) {
 const values = [];
 walkSyntax(tree, node => {
  const value = stringValue(node);
  if (value !== undefined) values.push(value);
  if (node.type === 'TemplateElement' && node.value.cooked !== null) values.push(node.value.cooked);
 });
 return values;
}
