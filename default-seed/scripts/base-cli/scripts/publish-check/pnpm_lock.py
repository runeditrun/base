"""Bound registry deprecation text to its quoted lockfile value."""
import re

QUOTED = rb"'(?:[^'\r\n]|'')*'|\"(?:[^\"\\\r\n]|\\[^\r\n])*\""
PACKAGES = re.compile(rb'packages:[ \t]*(?:#.*)?$')
ENTRY = re.compile(rb'  (?:' + QUOTED + rb'|[^\s\'"#][^:\r\n]*):[ \t]*(?:#.*)?$')
DEPRECATED = re.compile(rb'    deprecated:[ \t]+(?P<value>' + QUOTED + rb')[ \t]*(?:#.*)?$')


def continuing_quote(line, quote):
    """Keep a quoted scalar on earlier lines from lending its contents structure."""
    index = 0
    while index < len(line):
        char = line[index:index + 1]
        if quote:
            if quote == b'"' and char == b'\\':
                index += 2
                continue
            if char == quote:
                if quote == b"'" and line[index + 1:index + 2] == quote:
                    index += 2
                    continue
                quote = None
        elif char == b'#' and (index == 0 or line[index - 1:index].isspace()):
            break
        elif char in (b"'", b'"') and (index == 0 or line[index - 1] in b' \t:[{,?-'):
            quote = char
        index += 1
    return quote


def without_deprecation_values(data, path):
    # Only the quoted deprecated value at four spaces beneath a two-space
    # package entry in top-level packages qualifies, with this exact basename.
    if path.rsplit('/', 1)[-1] != 'pnpm-lock.yaml':
        return data
    packages = package = False
    quote = None
    result = []
    for line in data.splitlines(keepends=True):
        content = line.rstrip(b'\r\n')
        if quote is None and content.strip() and not content.lstrip().startswith(b'#'):
            if not content.startswith((b' ', b'\t')):
                packages = bool(PACKAGES.fullmatch(content))
                package = False
            elif content.startswith(b'  ') and not content.startswith((b'   ', b'  \t')):
                package = packages and bool(ENTRY.fullmatch(content))
            elif not content.startswith(b'    '):
                package = False
            match = DEPRECATED.fullmatch(content) if package else None
            if match:
                start, end = match.span('value')
                line = line[:start] + b' ' * (end - start) + line[end:]
        quote = continuing_quote(content, quote)
        result.append(line)
    return b''.join(result)
