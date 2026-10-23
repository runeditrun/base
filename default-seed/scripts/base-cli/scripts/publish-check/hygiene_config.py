"""Base-owned defaults and explicit committed seed publication declarations."""
import json
import re
from publication_config import intended_public_repositories

# A home segment within a relative path is not an absolute home directory.
# Match the username itself so a bare home, including one with spaces, counts.
_IDENTIFIER = r'[A-Za-z_$][A-Za-z0-9_$]*'
_VARIABLE = rf'(?!(?:true|false|null|this|super)(?![A-Za-z0-9_$])){_IDENTIFIER}'
_INTERPOLATION = rf'\$\{{[ \t]*{_VARIABLE}(?:[ \t]*\.[ \t]*{_IDENTIFIER})*[ \t]*\}}'
_HOME_PARAMETER = rf'(?::[A-Za-z_][A-Za-z0-9_]*|{_INTERPOLATION})'
_PATH_END = r'''(?=[\s"'<>`]|$)'''
_SEGMENT_END = rf'(?:[/\\]|{_PATH_END})'
# Inspect the entire token after a parameter. A suffix may have ordinary path
# components or plain interpolations, but cannot traverse or introduce another
# literal home. Unknown interpolation syntax cannot conceal the remaining path.
_SAFE_SUFFIX = rf'''
    (?:[/\\]
        (?!\.\.(?={_SEGMENT_END}|[?\#]))
        (?!(?:Users|home)[/\\]+(?!{_HOME_PARAMETER}(?={_SEGMENT_END}))[^/\\\s"'<>`]+)
        (?!(?i:[A-Z]:[/\\]+Users[/\\]+))
        (?:{_INTERPOLATION}|(?!\$\{{)[^/\\\s"'<>`])*
    )*{_PATH_END}'''
LOCAL_PATH = re.compile(rf'''(?x)
    (?<![^\s("'`=:\[<>{{|])(?:[*_]|~~)*
    (?:
        (?:(?i:(?a:file://)))?(?<!/[A-Z]:)/(?:Users|home)/
        # Exempt only a whole parameter with a suffix that cannot re-aim it.
        # Literal expressions, mixed segments and Windows homes still match.
        (?!{_HOME_PARAMETER}{_SAFE_SUFFIX})
        |(?i:(?:(?a:file:///))?[A-Z]:[\\/]+Users[\\/]+)
    )[^/\\\s"'<>`]+''')
CONFIG = '.publish-check/config.json'
# An alphabetic top-level label ends before a following digit, such as the DER
# tag after a certificate's email value; other labels keep the full extent.
# A period is punctuation unless it starts another host label; never shorten
# a suffixed host into a reserved/public domain.
EMAIL = re.compile(r"(?<![A-Za-z0-9_.+%-])[A-Za-z0-9_][A-Za-z0-9_.+%'-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.(?:[A-Za-z]{2,63}(?![A-Za-z-]|\.[A-Za-z0-9-])|[A-Za-z][A-Za-z0-9-]{1,62}(?![A-Za-z0-9-]|\.[A-Za-z0-9-]))|(?<![A-Za-z0-9_.+%-])[A-Za-z0-9_][A-Za-z0-9_.+%'-]{0,63}@(?:example|test|invalid)(?![A-Za-z0-9-]|\.[A-Za-z0-9-])", re.I)
RULES = {'hygiene.local-path', 'hygiene.github-private', 'hygiene.github-missing',
         'hygiene.email', 'hygiene.internal-reference'}


def load_config(data=None):
    config = json.loads(data) if data is not None else {'schemaVersion': 1}
    if not isinstance(config, dict) or config.get('schemaVersion') != 1 or set(config) - {'schemaVersion', 'publicEmails', 'internalReferencePatterns'}:
        raise ValueError('invalid publication config')
    emails = config.get('publicEmails', [])
    extra_patterns = config.get('internalReferencePatterns', [])
    if not isinstance(extra_patterns, list):
        raise ValueError('invalid internal references')
    patterns = extra_patterns
    if not isinstance(emails, list) or any(not isinstance(e, str) or not EMAIL.fullmatch(e) or '*' in e for e in emails):
        raise ValueError('invalid public emails')
    if not isinstance(patterns, list) or any(not isinstance(p, str) or not p for p in patterns):
        raise ValueError('invalid internal references')
    try:
        compiled = [re.compile(p) for p in patterns]
    except re.error:
        raise ValueError('invalid internal reference regex') from None
    return {'publicEmails': {e.lower() for e in emails}, 'internalReferencePatterns': compiled,
            'intendedPublicRepositories': intended_public_repositories()}


def public_email(address, config):
    domain = address.lower().rsplit('@', 1)[1]
    # RFC 2606 reserved names; .localhost also holds local dev personas (<as>@dev.localhost).
    reserved = ('example', 'test', 'invalid', 'localhost', 'example.com', 'example.net', 'example.org')
    return address.lower() in config['publicEmails'] or any(domain == d or domain.endswith('.' + d) for d in reserved)
