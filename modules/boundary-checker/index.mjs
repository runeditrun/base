import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateConfig } from './config.mjs'
import { createResolver } from './resolution.mjs'
import { projectPath } from './paths.mjs'
import { sourceFiles } from './walk.mjs'
import { extensions } from './rules/extensions.mjs'
import { features } from './rules/features.mjs'
import { database } from './rules/database.mjs'
import { platformImport, platformRead } from './rules/platform.mjs'
import { evaluation } from './rules/evaluation.mjs'
import { client } from './rules/client.mjs'
import { header } from './rules/header.mjs'

export async function checkBoundaries({ root, config = { version: 1 } }) {
  root = await realpath(resolve(root))
  config = validateConfig(config)
  const { ts, resolveSpecifier } = createResolver(root, config)
  const files = await sourceFiles(resolve(root, config.sourceRoot))
  const violations = []
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  for (const absolute of files) {
    const file = projectPath(root, absolute, { ignoreDependencies: false })
    const source = ts.createSourceFile(absolute, await readFile(absolute, 'utf8'), ts.ScriptTarget.Latest, true)
    const add = (rule, node, specifier, target, message) => {
      const position = source.getLineAndCharacterOfPosition(node ? node.getStart(source) : 0)
      violations.push({ rule, file, line: position.line + 1, column: position.character + 1, specifier, target, message })
    }
    const context = { ts, config, file, source, add }
    const inspect = node => {
      const edge = { node, specifier: node.text, target: resolveSpecifier(node.text, absolute) }
      for (const rule of [extensions, features, database, platformImport, client]) rule(context, edge)
    }
    const visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const typeOnly = node.isTypeOnly || node.importClause?.isTypeOnly ||
          (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name &&
            node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(entry => entry.isTypeOnly)) ||
          (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(entry => entry.isTypeOnly))
        if (node.moduleSpecifier && literal(node.moduleSpecifier) && (config.includeTypeOnly || !typeOnly)) inspect(node.moduleSpecifier)
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && literal(node.arguments[0])) inspect(node.arguments[0])
      evaluation(context, node, literal)
      platformRead(context, node)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
    header(context)
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule) || a.column - b.column)
  return { files: files.length, violations }
}
