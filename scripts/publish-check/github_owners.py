"""GitHub owner context from inputs and same-tree content, without lookups."""
import json
from github_refs import FULL, URL, SERVICE_URL, SPONSORS_URL, normalize
from hygiene_text import decoded_text
from project_identity import FIELDS


def url_owners(text):
    text = SERVICE_URL.sub('', text)
    return {normalize(match[1]).split('/')[0] for match in URL.finditer(text)
            if not SPONSORS_URL.match(text, match.start())}


def input_owners(project, repository, public_base):
    owners = url_owners('\n'.join(value for value in (repository, public_base) if value))
    if isinstance(project, str) and FULL.fullmatch(project):
        owners.add(normalize(project).split('/')[0])
    return frozenset(owners)


def content_owners(data, path):
    text = decoded_text(data)
    owners = url_owners(text)
    if path in FIELDS:
        try:
            document = json.loads(text)
        except ValueError:
            document = None
        value = document.get(FIELDS[path]) if isinstance(document, dict) else None
        if isinstance(value, str) and FULL.fullmatch(value):
            owners.add(normalize(value).split('/')[0])
    return owners
