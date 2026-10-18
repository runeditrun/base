"""Strict JSON documents and exact native-match byte locations."""
import json
import re

from hit_location import match_spans

HEX = re.compile(r'[a-f0-9]{64}\Z')
GIT_REVISION = re.compile(r'[a-f0-9]{40}\Z')


class Document:
    """Reject ambiguous/non-JSON input and retain exact byte spans of strings."""
    def __init__(self, data):
        self.data = data
        text = data.decode('utf-8')
        self.spans = {}
        char_at = byte_at = 0

        def byte_offset(at):
            nonlocal char_at, byte_at
            # Parsing visits string spans in source order. Encode each intervening
            # segment once, including UTF-8 in keys and non-identity values.
            byte_at += len(text[char_at:at].encode('utf-8'))
            char_at = at
            return byte_at

        def invalid_constant(_):
            raise ValueError('Non-JSON constant')

        decoder = json.JSONDecoder(parse_constant=invalid_constant)

        def whitespace(at):
            while at < len(text) and text[at] in ' \t\r\n':
                at += 1
            return at

        def parse(at, pointer):
            at = whitespace(at)
            if text[at] in '{[':
                mapping = text[at] == '{'
                end = '}' if mapping else ']'
                result = {} if mapping else []
                at = whitespace(at + 1)
                if text[at] == end:
                    return result, at + 1
                while True:
                    if mapping:
                        key, at = decoder.raw_decode(text, at)
                        if not isinstance(key, str) or key in result:
                            raise ValueError('Ambiguous JSON member')
                        at = whitespace(at)
                        if text[at] != ':':
                            raise ValueError('Invalid JSON member')
                        at += 1
                    else:
                        key = len(result)
                    value, at = parse(at, (*pointer, key))
                    if mapping:
                        result[key] = value
                    else:
                        result.append(value)
                    at = whitespace(at)
                    if text[at] == end:
                        return result, at + 1
                    if text[at] != ',':
                        raise ValueError('Invalid JSON separator')
                    at = whitespace(at + 1)
            value, end = decoder.raw_decode(text, at)
            if isinstance(value, str) and (HEX.fullmatch(value) or GIT_REVISION.fullmatch(value)):
                self.spans[pointer] = (byte_offset(at), byte_offset(end), value)
            return value, end

        self.value, end = parse(0, ())
        if whitespace(end) != len(text):
            raise ValueError('Trailing JSON data')

    def matches(self, hit, pointers):
        if hit.get('RuleID') not in ('generic-api-key', 'hex-api-key'):
            return False
        secret = hit.get('Secret', '').encode('utf-8')
        if not secret:
            return False
        located = set()
        for left, right in match_spans(self.data, hit):
            start = self.data.find(secret, left, right)
            if start < 0 or self.data.find(secret, start + 1, right) >= 0:
                continue
            for pointer in pointers:
                span = self.spans.get(pointer)
                if span:
                    a, b, value = span
                    # Native fragments can truncate a digest capture. Bind the
                    # captured secret's bytes, including a partial capture, to
                    # this exact unescaped JSON value.
                    if (a + 1 <= start and start + len(secret) <= b - 1
                            and self.data[a + 1:b - 1] == value.encode('ascii')):
                        located.add((a, b))
        return len(located) == 1
