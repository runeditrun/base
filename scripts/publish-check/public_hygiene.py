"""Public-tree and message hygiene; findings never include matched values."""
from collections import Counter
import re
from github_refs import REPOSITORY_HOSTS, reference_sets
from destination import RULE as PENDING_DESTINATION
from hygiene_text import decoded_text
from provenance import provenance_text
from hygiene_config import EMAIL, LOCAL_PATH, public_email
from font_licence import without_required_notices
from trust_bundle import anchor_values
from png_text import text_chunks
from media import sample_spans
from c2pa import certificate_spans
from lockfile_metadata import without_package_contacts
URI_AUTHORITY = re.compile(r'''//(?P<authority>[^/?#\s<>"']+)''')
ACTION_REFERENCE = re.compile(r'''uses:\s*["']?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[^\s"']+''')
SCHEME_CHARACTERS = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-')
# Match raw, complete commit trailer lines; decoded or embedded prose cannot
# acquire trailer privileges. Only the address span is omitted from email checks.
COAUTHOR = re.compile(
    rb'^Co-Authored-By:[ \t]+(?=[^ \t])[^<>\r\n]*[^<>\s][ \t]+<(?P<address>'
    rb'noreply@(?:anthropic|openai|github)\.com|'
    rb'[0-9]+\+[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}@users\.noreply\.github\.com'
    rb')>[ \t]*\r?$', re.I | re.M)


def without_public_coauthor_addresses(data):
    # A trailer block is the final paragraph and contains only trailer lines.
    # A quoted attribution followed by ordinary prose stays ordinary body text.
    tail = data.rstrip(b' \t\r\n')
    block = re.split(rb'\r?\n[ \t]*\r?\n', tail)[-1]
    if not all(re.fullmatch(rb'[A-Za-z0-9-]+:[ \t][^\r\n]+\r?', line)
               for line in block.split(b'\n')):
        return data
    offset = len(tail) - len(block)
    result = bytearray(data)
    for match in COAUTHOR.finditer(block):
        start, end = match.span('address')
        result[offset + start:offset + end] = b' ' * (end - start)
    return bytes(result)


def without_transport_hosts(text):
    pieces, offset = [], 0
    for match in URI_AUTHORITY.finditer(text):
        start = match.start()
        colon = start - 1
        if colon >= offset and text[colon] == ':':
            # The optional scheme regex retried every suffix of a long run.
            # Walk this gap once, stopping at the previous authority's end so
            # matches keep the original substitution's non-overlapping bounds.
            scheme = colon
            while scheme > offset and text[scheme - 1] in SCHEME_CHARACTERS:
                scheme -= 1
            while scheme < colon and not text[scheme].isalpha():
                scheme += 1
            if scheme < colon:
                start = scheme
        userinfo, _, host = match['authority'].rpartition('@')
        # Without a scheme, arbitrary //text can also be a source comment.
        if start == match.start() and host.lower().split(':', 1)[0] not in REPOSITORY_HOSTS:
            pieces.append(text[offset:match.end()])
        else:
            pieces.append(text[offset:start])
            # Keep actual email-valued userinfo, including a decoded %40,
            # while excluding an ordinary transport username@host delimiter.
            pieces.append(userinfo)
        offset = match.end()
    pieces.append(text[offset:])
    return ''.join(pieces)


def private_emails(text, config):
    # URL paths, queries and fragments remain visible to email inspection.
    email_text = without_transport_hosts(without_required_notices(text))
    email_text = re.sub(r'(?i)\b(?a:git@github\.com:)(?=[A-Za-z0-9]|\$\{[A-Za-z_$][A-Za-z0-9_.$]*\})', '', email_text)
    # A package manager's patch filename joins the name and version with an at sign.
    version = r'(?:v?[0-9]+(?:\.[0-9]+)*(?:-[A-Za-z0-9-]+)?|[a-f0-9]{40})(?:\.patch)?(?![A-Za-z0-9_.-])'
    email_text = without_action_references(email_text)
    # Only the first character of a package token can change the outcome.
    # Keep the outer boundary for scopes preceded by punctuation (x.@scope/pkg).
    email_text = re.sub(r'(?<![A-Za-z0-9])(?:@[A-Za-z0-9_.-]+/)?(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?@' + version, '', email_text)
    return [match.group() for match in EMAIL.finditer(email_text) if not public_email(match.group(), config)]


def without_action_references(text):
    pieces, offset = [], 0
    for match in ACTION_REFERENCE.finditer(text):
        # Locate the literal first, then walk each whitespace gap once. A
        # multiline ^\s*-?\s* retries and repartitions long blank-line runs.
        start = match.start()
        while start > offset and text[start - 1].isspace():
            start -= 1
        if start > offset and text[start - 1] == '-':
            start -= 1
            while start > offset and text[start - 1].isspace():
                start -= 1
        if start > 0 and text[start - 1] != '\n':
            newline = text.find('\n', start, match.start())
            if newline < 0:
                continue
            start = newline + 1
        pieces.append(text[offset:start])
        offset = match.end()
    pieces.append(text[offset:])
    return ''.join(pieces)


# A stored host name is lower case, upper case or capitalised, label by label.
# Bytes that merely decode to text, such as compressed pixels, rarely are.
HOST_LABEL = re.compile(r'(?:[a-z0-9-]+|[A-Z0-9-]+|[A-Z][a-z0-9-]*)')


# Control bytes that no text encoding uses (tab, newline, form feed and carriage
# return are text). Legacy 8-bit text such as latin-1 or Windows-1252 has none,
# while compressed or packed data is about one byte in nine.
NON_TEXT = re.compile(rb'[\x01-\x08\x0b\x0e-\x1f\x7f]')
BINARY_SHARE = 0.05


def binary(data):
    # NULs are not counted: UTF-16 and UTF-32 text carries them between letters.
    text = data.replace(b'\0', b'')
    return bool(text) and len(NON_TEXT.findall(text)) / len(text) > BINARY_SHARE


def stored_host(address):
    return all(HOST_LABEL.fullmatch(label) for label in address.rsplit('@', 1)[1].split('.'))


def certificate_metadata(data, bundle, emails, config):
    # Every match lies inside a verified trust-anchor subject value: none
    # remains once those values are blanked, and each is one of theirs.
    spans = anchor_values(data, bundle)
    if not spans:
        return False
    blanked = bytearray(data)
    for start, end in spans:
        blanked[start:end] = b' ' * (end - start)
    if private_emails(decoded_text(bytes(blanked)), config):
        return False
    inside = Counter(match.group() for start, end in spans for match in EMAIL.finditer(decoded_text(data[start:end])))
    return not Counter(emails) - inside


def without_spans(data, spans):
    # Each span becomes one space: text on either side stays apart, and no
    # long blank run is left for the line-anchored patterns to rescan.
    kept, offset = [], 0
    for start, end in sorted(spans):
        kept.append(data[offset:start])
        offset = max(offset, end)
    kept.append(data[offset:])
    return b' '.join(kept)


def inspect(data, path, config, *, commit_message=False):
    chunks = list(text_chunks(data))
    # Image and video samples are not text: they can spell an address or a
    # path by chance. Comments, XMP, tags and other metadata remain text.
    spans = sample_spans(data) or []
    # Names in a C2PA manifest's signing certificates are certificate metadata.
    spans += certificate_spans(data)
    rules, provenance, references = set(), False, set()
    for start, end, fields in chunks:
        spans.append((start, end))
        for field in fields:
            # A metadata value is text, not a standalone source manifest or
            # trust bundle, even when the containing image has a JSON name.
            field_rules, field_provenance, field_references = inspect_text(field, '@png-text', config, binary_content=False)
            rules.update(field_rules)
            provenance |= field_provenance
            references |= field_references
    # Keep the original binary classification for content outside text chunks.
    # CRC-adjacent bytes must not also create a synthetic raw mailbox match.
    raw_rules, raw_provenance, raw_references = inspect_text(without_spans(data, spans), path, config,
                                                            commit_message=commit_message, binary_content=binary(data))
    rules.update(raw_rules)
    provenance |= raw_provenance
    return rules, provenance, frozenset(references | raw_references)


def inspect_text(data, path, config, *, commit_message=False, binary_content=None):
    # NUL removal covers UTF-16/32 ASCII content, matching the secret scanner.
    text = decoded_text(data)
    rules = set()
    if LOCAL_PATH.search(text):
        rules.add('hygiene.local-path')
    if any(pattern.search(text) for pattern in config['internalReferencePatterns']):
        rules.add('hygiene.internal-reference')
    if '@' in text:
        email_data = without_public_coauthor_addresses(data) if commit_message else without_package_contacts(data, path.rsplit('/', 1)[-1])
        email_text = decoded_text(email_data)
        emails = private_emails(email_text, config)
        bundle = config.get('trustBundles', {}).get(path)
        if emails and not (bundle and certificate_metadata(data, bundle, emails, config)):
            # Inside binary data a mailbox is judged by its own shape: a host
            # name with mixed-case letters inside a label is not one.
            if not (binary(data) if binary_content is None else binary_content) or any(stored_host(email) for email in emails):
                rules.add('hygiene.email')
    ref_text, provenance = provenance_text(text, path, config.get('declaredSources', frozenset()))
    stated, ambiguous = reference_sets(ref_text, path, config.get('localPaths', frozenset()), config.get('projectIdentity'))
    references = set()
    for repository in stated | ambiguous:
        # A future source identity does not assert current GitHub visibility.
        # Explicit release destinations still take the strict visibility path.
        if (repository in config.get('intendedPublicRepositories', frozenset()) and
                repository != config.get('pendingDestination')):
            continue
        references.add((repository, repository in ambiguous, repository == config.get('pendingDestination')))
    return rules, provenance, frozenset(references)


def reference_rules(references, states):
    """Rules for (repository, ambiguous, pending destination) references once their states are known."""
    rules = set()
    for repository, ambiguous, pending in references:
        state = states[repository]
        # A bare word/word with no GitHub context names a repository only when
        # one exists privately; that no repository answers to it proves nothing.
        if state == 'missing' and ambiguous and not pending:
            continue
        if state == 'missing' and pending:
            rules.add(PENDING_DESTINATION)
        elif state in ('private', 'missing'):
            rules.add('hygiene.github-' + state)
        elif state != 'public':
            rules.add('scan.github-incomplete')
    return rules
