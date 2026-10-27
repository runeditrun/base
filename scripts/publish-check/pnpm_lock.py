"""Bound registry deprecation text to a quoted scalar in a package mapping."""
import re

QUOTED = rb"'(?:[^'\r\n]|'')*'|\"(?:[^\"\\\r\n]|\\[^\r\n])*\""
KEY = re.compile(rb'(?P<key>' + QUOTED + rb'|[^\s\'"#\[\]{},&*!|>@`?:][^:\r\n]*?):(?:[ ]+|$)')
TAIL = re.compile(rb' *(?:#.*)?(?:\r?\n|$)')


class Ambiguous(ValueError):
    """Unsupported or inconsistent YAML keeps every byte under inspection."""


def quoted_end(data, start):
    quote, index = data[start], start + 1
    while index < len(data):
        char = data[index]
        if quote == 34 and char == 92:
            escape = data[index + 1:index + 2]
            width = {b'x': 2, b'u': 4, b'U': 8}.get(escape)
            if width:
                digits = data[index + 2:index + 2 + width]
                if len(digits) != width or re.fullmatch(rb'[0-9a-fA-F]+', digits) is None:
                    raise Ambiguous()
                if int(digits, 16) > 0x10ffff or 0xd800 <= int(digits, 16) <= 0xdfff:
                    raise Ambiguous()
                index += 2 + width
            elif escape and escape in b'0abtnvfre "/\\N_LP\r\n\t':
                index += 2
            else:
                raise Ambiguous()
        elif char == quote:
            if quote == 39 and data[index + 1:index + 2] == b"'":
                index += 2
            else:
                return index + 1
        else:
            index += 1
    raise Ambiguous()


def flow_end(data, start):
    # Each collection remembers whether a key, value or separator is due.
    stack, index = [], start
    while index < len(data):
        char = data[index]
        if char == 9:
            raise Ambiguous()
        if char in b' \r\n':
            index += 1
            continue
        if char == 35 and (index == 0 or data[index - 1] in b' \r\n'):
            newline = data.find(b'\n', index)
            index = len(data) if newline < 0 else newline + 1
            continue
        if stack:
            closing, state = stack[-1]
            if char == closing and state in ('key', 'value', 'separator'):
                stack.pop()
                if not stack:
                    return index + 1
                index += 1
                continue
            if state == 'separator':
                if char != 44:
                    raise Ambiguous()
                stack[-1][1] = 'key' if closing == 125 else 'value'
                index += 1
                continue
            if state == 'colon':
                if char != 58:
                    raise Ambiguous()
                stack[-1][1] = 'value'
                index += 1
                continue
            stack[-1][1] = 'colon' if state == 'key' else 'separator'
        if char in b'[{':
            stack.append([93 if char == 91 else 125, 'value' if char == 91 else 'key'])
            index += 1
        elif char in (39, 34):
            index = quoted_end(data, index)
        elif char in b'&*!,:]}':
            raise Ambiguous()
        else:
            # Quotes inside a plain token cannot start a quoted scalar.
            begin = index
            while index < len(data):
                char = data[index]
                if char == 9:
                    raise Ambiguous()
                if char in b',[]{}' or (char == 58 and data[index + 1:index + 2] in
                                       (b' ', b'\r', b'\n', b'[', b'{')):
                    break
                if char == 35 and data[index - 1] in b' \r\n':
                    break
                index += 1
            if not data[begin:index].strip():
                raise Ambiguous()
    raise Ambiguous()


def without_deprecation_values(data, path):
    if path.rsplit('/', 1)[-1] != 'pnpm-lock.yaml':
        return data
    try:
        data.decode('utf-8')
    except UnicodeDecodeError:
        return data
    if any(char < 32 and char not in (9, 10, 13) for char in data):
        return data
    # This deliberately recognizes a conservative YAML subset. In particular,
    # aliases, tags, complex keys and malformed scalar tails cannot grant trust.
    spans, parents, seen, containers = [], [], {}, {}
    plain_indent = None
    index = 0
    try:
        while index < len(data):
            end = data.find(b'\n', index)
            end = len(data) if end < 0 else end + 1
            line = data[index:end].rstrip(b'\r\n')
            indent = len(line) - len(line.lstrip(b' '))
            content = line[indent:]
            if not content or content.startswith(b'#'):
                index = end
                continue
            if plain_indent is not None and indent > plain_indent:
                # Quotes and collection markers inside a continued plain or
                # block scalar are text, never new YAML tokens.
                if b'\t' in re.split(rb' +#', content, maxsplit=1)[0]:
                    raise Ambiguous()
                index = end
                continue
            plain_indent = None
            if content in (b'---', b'...'):
                raise Ambiguous()
            while parents and parents[-1][0] >= indent:
                parents.pop()
            if indent and not parents:
                raise Ambiguous()
            sequence = content.startswith(b'- ')
            shape = (indent, sequence)
            if containers.setdefault(tuple(parents), shape) != shape:
                raise Ambiguous()
            if sequence:
                content = content[2:]
                # Sequence items cannot be package-entry fields.
                parents.append((indent, b'-', index))
                indent += 2
            match = KEY.match(content)
            if not match and not sequence:
                raise Ambiguous()
            key = match['key'].rstrip(b' ') if match else b'-value'
            if key[:1] in (b"'", b'"'):
                if quoted_end(key, 0) != len(key):
                    raise Ambiguous()
            elif b'\t' in key or re.search(rb' +#', key):
                raise Ambiguous()
            location = tuple(parents)
            field_indent, keys = seen.setdefault(location, (indent, set()))
            if indent != field_indent or (key in keys and not sequence):
                raise Ambiguous()
            keys.add(key)
            value_start = index + (len(line) - len(content)) + (match.end() if match else 0)
            value = data[value_start:end].rstrip(b'\r\n')
            own = (not sequence and indent == 4 and key == b'deprecated'
                   and len(parents) == 2 and parents[0] == (0, b'packages')
                   and len(parents[1]) == 2 and parents[1][0] == 2)
            if not value or value.startswith(b'#'):
                parents.append((indent, key))
                index = end
                continue
            if value[:1] in (b"'", b'"', b'[', b'{'):
                scalar_end = (quoted_end(data, value_start) if value[:1] in (b"'", b'"')
                              else flow_end(data, value_start))
                tail = TAIL.match(data, scalar_end)
                if not tail:
                    raise Ambiguous()
                if own and value[:1] in (b"'", b'"'):
                    spans.append((value_start, scalar_end))
                index = tail.end()
                if sequence and not match:
                    parents.pop()
            elif value[:1] in (b'&', b'*', b'!', b'?', b'@', b'`'):
                raise Ambiguous()
            else:
                if b'\t' in re.split(rb' +#', value, maxsplit=1)[0]:
                    raise Ambiguous()
                if value[:1] in (b'|', b'>') and not re.fullmatch(
                        rb'[|>](?:[1-9][+-]?|[+-][1-9]?)? *(?:#.*)?', value):
                    raise Ambiguous()
                plain_indent = indent - 2 if sequence and not match else indent
                if sequence and not match:
                    parents.pop()
                index = end
    except Ambiguous:
        return data
    result = bytearray(data)
    for start, end in spans:
        result[start:end] = re.sub(rb'[^\r\n]', b' ', data[start:end])
    return bytes(result)
