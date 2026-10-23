"""Canonical home paths, with a conservative exemption for parameter routes."""
import re

_IDENTIFIER = r'[A-Za-z_$][A-Za-z0-9_$]*'
_VARIABLE = rf'(?!(?:true|false|null|this|super)(?![A-Za-z0-9_$])){_IDENTIFIER}'
_INTERPOLATION = rf'\$\{{[ \t]*{_VARIABLE}(?:[ \t]*\.[ \t]*{_IDENTIFIER})*[ \t]*\}}'
_PARAMETER = rf'(?::[A-Za-z_][A-Za-z0-9_]*|{_INTERPOLATION})'
_BOUNDARY = r'''(?=[/\\\s?\#"'<>`]|$)'''
PARAMETER = re.compile(_PARAMETER + _BOUNDARY)
INTERPOLATION = re.compile(_INTERPOLATION)
HOME = re.compile(r'''(?x)
    (?<![^\s("'`=:\[<>{{|])(?:[*_]|~~)*
    (?:
        (?P<posix>(?:(?i:(?a:file://)))?(?<!/[A-Z]:)/(?:Users|home)/)
        |(?i:(?:(?a:file:///))?[A-Z]:[\\/]+Users[\\/]+)
    )[^/\\\s"'<>`]+''')
TRAVERSAL = re.compile(r'(?:^|[/\\])\.\.(?=[/\\\s?\#]|$)')
LATER_HOME = re.compile(rf'''(?x)
    [/\\](?:Users|home)[/\\]+(?!{_PARAMETER}{_BOUNDARY})[^/\\\s"'<>`]+
    |(?i:[A-Z]:[/\\]+Users[/\\]+)''')
QUOTE = re.compile(r'''\\[\s\S]|["'`\n]''')
CONTINUATION = re.compile(r'\\\r?\n')
FRAGMENT = re.compile(r"[\"'`]\s*(?:[/\\]|\.\.)")


def quote_at(text, end):
    """Find the surrounding source/Markdown quote without evaluating source."""
    quote = None
    for token in QUOTE.finditer(text, 0, end):
        char = token.group()
        if char.startswith('\\'):
            continue
        if char == '\n':
            if quote != '`':
                quote = None
        elif quote == char:
            quote = None
        elif quote is None:
            quote = char
    return quote


def statement_remainder(text, start):
    """Inspect later arguments/fragments, stopping at a separate statement."""
    at, quote, depth = start, None, 0
    continued = False
    while at < len(text):
        char = text[at]
        if char == '\\' and at + 1 < len(text):
            at += 2
            continue
        if quote:
            if char == quote:
                quote = None
        elif char in '\"\'`':
            quote = char
        elif char == ';' or (char == '\n' and not depth and not continued):
            break
        elif char in '([':
            depth += 1
        elif char in ')]':
            if not depth:
                break
            depth -= 1
        elif not char.isspace():
            continued = char in ',+'
        at += 1
    tail = CONTINUATION.sub('', text[start:at])
    return bool(TRAVERSAL.search(tail) or LATER_HOME.search(tail) or FRAGMENT.search(tail))


def joined(text, at):
    # Even a closed quote is not an end if an expression continues. Unknown
    # joins (including calls/member access) fail closed rather than evaluating
    # source. Skip wrapping delimiters and comments before deciding.
    line_end = False
    while at < len(text):
        if text[at].isspace() or text[at] in ')]}':
            line_end |= text[at] == '\n'
            at += 1
        elif text.startswith('/*', at):
            end = text.find('*/', at + 2)
            if end < 0:
                return True
            line_end |= '\n' in text[at:end + 2]
            at = end + 2
        elif text.startswith('//', at):
            end = text.find('\n', at + 2)
            line_end |= end >= 0
            at = len(text) if end < 0 else end + 1
        elif match := CONTINUATION.match(text, at):
            at = match.end()
        else:
            return (text[at] in '''+['"`\\'''
                    or (text[at] == '.' and at + 1 < len(text)
                        and (text[at + 1].isalnum() or text[at + 1] in '_$('))
                    or (not line_end and statement_remainder(text, at)))
    return False


def route_tail(text, start, quote):
    at = start
    while at < len(text):
        char = text[at]
        if char == '\\' and at + 1 < len(text):
            at += 2
            continue
        if (quote and char == quote) or (not quote and char in '''"'`<>;\n'''):
            return None if joined(text, at + (char in '''"'`''')) else text[start:at]
        at += 1
    return text[start:at]


def parameter_route(text, match):
    start = match.end('posix')
    if not PARAMETER.match(text, start):
        return False
    tail = route_tail(text, start, quote_at(text, match.start()))
    if tail is None:
        return False
    # Join escaped physical newlines only for this check; other hygiene rules
    # continue to inspect their original decoded text.
    tail = CONTINUATION.sub('', tail)
    parameter = PARAMETER.match(tail)
    return bool(parameter and not TRAVERSAL.search(tail) and not LATER_HOME.search(tail)
                and '${' not in INTERPOLATION.sub('', tail))


def local_path(text):
    """Return the first non-exempt match for detection and report redaction."""
    for match in HOME.finditer(text):
        if not match.group('posix') or not parameter_route(text, match):
            return match
    return None
