export function evaluation({ ts, config, add }, node, literal) {
  if (!config.rules.R6.enabled) return
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !literal(node.arguments[0])) {
    add('R6', node, null, null, 'non-literal dynamic import is not allowed')
  }
  if ((ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') ||
      (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function')) {
    add('R6', node, null, null, 'runtime code evaluation is not allowed')
  }
}
