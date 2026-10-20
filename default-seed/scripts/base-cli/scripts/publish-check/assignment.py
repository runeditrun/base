"""Require a complete identifier key for comma-separated credential pairs."""
import re

from hit_location import match_spans

IDENTIFIER = re.compile(br'[A-Za-z0-9_-]+\Z')
COMMA = re.compile(br''',[\x60'"\s=]{0,5}\Z''')
BOUNDARIES = b" \t\r\n\v\f\"'`[]{}(),;:=<>|?"


def identifier_before(data, end):
    left = data[:end].rstrip()
    if not left:
        return False
    end = len(left)
    if left[-1] in b"\"'":
        quote = left[-1]
        start = end - 2
        while start >= 0:
            if left[start] == quote:
                previous = start - 1
                while previous >= 0 and left[previous] == ord('\\'):
                    previous -= 1
                if (start - previous - 1) % 2 == 0:
                    return bool(IDENTIFIER.fullmatch(left[start + 1:end - 1]))
            start -= 1
        return False
    start = end
    while start and left[start - 1] not in BOUNDARIES:
        start -= 1
    return bool(IDENTIFIER.fullmatch(left[start:end]))


def is_assignment(data, hit):
    # Gitleaks alone decides whether the right value meets its entropy/length
    # policy (or the hex rule). Every other assignment operator is unchanged.
    if hit.get('RuleID') not in ('generic-api-key', 'hex-api-key'):
        return True
    match = hit.get('Match', '').encode('utf-8')
    secret = hit.get('Secret', '').encode('utf-8')
    value = match.rfind(secret) if secret else -1
    comma = COMMA.search(match[:value]) if value >= 0 else None
    if comma is None:
        return True
    spans = match_spans(data, hit)
    # Keep findings whose exact native location cannot be resolved. Reading the
    # whole left token also rejects a key-like suffix inside a path or string.
    return not spans or any(identifier_before(data, start + comma.start()) for start, _ in spans)
