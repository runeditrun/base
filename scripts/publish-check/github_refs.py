"""Resolve publication references with gh's local credentials; retain booleans only."""
import json
import os
import re
import subprocess
import unicodedata
from repository_intent import declarations, commands

SLUG = r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
PAIR = SLUG + '/' + SLUG
URL_BOUNDARY = r'(?<![A-Za-z0-9_./@+-])'
TRANSPORT = r'(?:[a-z][a-z0-9+.-]*://|(?<!:)//)'
USERINFO = r'''(?:[^/\s@"'<>`]+@)?'''
PORT = r'(?::[0-9]+)?'
REPOSITORY_HOSTS = {'github.com': '/', 'www.github.com': '/', 'ssh.github.com': '/',
                    'raw.githubusercontent.com': '/', 'api.github.com': '/repos/',
                    'codeload.github.com': '/'}
REPOSITORY_HOST = '(?:' + '|'.join('(?a:' + re.escape(host) + ')' + PORT + route for host, route in REPOSITORY_HOSTS.items()) + ')'
# Embedded patterns retain ASCII scheme/host folding without changing the
# surrounding text and repository-path recognition used by privacy inspection.
URL = re.compile(r'(?i)' + URL_BOUNDARY + r'(?:(?a:' + TRANSPORT + ')' + USERINFO + REPOSITORY_HOST +
                 r'|(?a:git@github\.com:))(' + PAIR + r')(?![A-Za-z0-9_.-])')
FULL = re.compile(PAIR + r'\Z')
IDENTITY_FIELDS = {'edition.json': 'id', 'sources.lock.json': 'edition', 'rer-project.json': 'projectId'}
TOKEN = re.compile(r'(?<![\w./@+-])(' + PAIR + r')(?![A-Za-z0-9_.-])')
QUALIFIER = re.compile(r'(?:#[0-9]+(?![A-Za-z0-9_])|@[a-fA-F0-9]{7,40}(?![A-Za-z0-9_])|/(?:pull|issues|tree|blob)/)')
METADATA = re.compile(r'(?i)(?:^|/)(?:[^/]+\.(?:json|ya?ml|toml)|\.gitmodules)$')
# GitHub documents these web auth endpoints, not repository namespaces.
SERVICE_URL = re.compile(r'(?i)' + URL_BOUNDARY + r'(?a:https?://|(?<!:)//)' + USERINFO +
                         r'(?a:(?:www\.)?github\.com)' + PORT +
                         r'''/(?:login/oauth/(?:authorize|access_token)|login/device(?:/code)?)(?=[?#\s"'`<>)]|$)''')
# Only the complete web endpoint is a service; transports and repository
# declarations retain their original repository meaning.
SPONSORS_URL = re.compile(URL_BOUNDARY + r'(?a:https?://|(?<!:)//)' + USERINFO +
                          r'(?a:(?:www\.)?github\.com)' + PORT +
                          r'''/(?-i:sponsors)/(?a:[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/?(?=[?#\s"'`<>)]|$)''', re.I)
FILE_SUFFIX = re.compile(r'(?i)\.(?:xml|json|ya?ml|toml|[cm]?[jt]sx?|md|txt|html|css|sql|png|jpe?g|svg|zip|csv|pdf|docx|xlsx|rer)$')
DEPENDENCY = re.compile(r'(?i)\bgithub:(' + PAIR + r')(?![A-Za-z0-9_./-])')
ACTION = re.compile(r'''(?im)^\s*(?:-\s*)?uses\s*:\s*["']?(''' + PAIR + r''')(?:/[A-Za-z0-9_./-]+)?@[^\s"']+''')
REPOSITORY_FIELD = re.compile(r'''(?im)(?<![\w$])["'`]?(?:repository|repo|github|sourceRepository)["'`]?\s*[:=]\s*["'`]?(''' + PAIR + r''')(?![A-Za-z0-9_./-])''')
# A code span such as `dist/client` names a path in the project, not an owner/repo.
LOCAL_DIRECTORIES = frozenset({'dist', 'src', 'scripts', 'public', 'tests', 'docs', 'exports', 'node_modules', '.rer', '.seed'})
SOURCE = re.compile(r'(?i)\.[cm]?[jt]sx?$')
TYPED_REPOSITORY = re.compile(r'''(?im)(?<![\w$])(?:repository|repo|github|sourceRepository)\s*:\s*string\s*=\s*["'`](''' + PAIR + r''')["'`]''')
DECLARED_SHORTHAND = re.compile(r'''(?im)(?<![\w$])["'`]?(?:url|fullURL)["'`]?\s*[:=]\s*["'`](''' + PAIR + r''')["'`]''')
REPOSITORY_ROUTE = re.compile(r'/(?:tree|blob|issues|pull|pulls|commit|commits|releases|actions|wiki|discussions|compare|tags)(?:/|$)')
SHORTHAND = PAIR + r'(?:[/?#][^\s`<>]*)?'
REPOSITORY_CONTEXT = r'github|repository|repo|source|upstream|downstream|fork(?:ed)?(?:\s+(?:from|of|into))?|clone(?:d)?(?:\s+from)?|gh\s+repo\s+(?:clone|view|fork)'
MARKUP = r'[`*_~\[\]]*'
MARKDOWN_REFERENCE = re.compile(r'`(?P<code>' + SHORTHAND + r')`|(?<![A-Za-z])(?P<label>(?i:' + REPOSITORY_CONTEXT + r'))(?:\s+(?:repository|repo))?' + MARKUP + r'(?P<separator>\s*[:=|]\s*|\s+)(?P<markup>' + MARKUP + r')\s*(?P<reference>' + SHORTHAND + r')(?![A-Za-z0-9_./-])')

EXPLICIT_URL = re.compile(r'''(?im)["']?(?:repository|repo|github|sourceRepository)["']?\s*[:=]\s*(?:\{\s*["']?(?:url|fullURL)["']?\s*:\s*)?[`*_~\["']*\s*(''' + URL.pattern.replace('(?i)', '') + ')', re.I)
CONTEXT_URL = re.compile(r'(?i)(?<![A-Za-z])(?:' + REPOSITORY_CONTEXT + r')'
                         r'(?:\s+(?:repository|repo))?' + MARKUP + r'(?:\s*[:=|]\s*|\s+)'
                         + r'''[`*_~\[\]\s"']*(?:''' + URL.pattern.replace('(?i)', '') + ')')
LINK_URL = re.compile(r'(?i)\[(?P<label>[^]\n]+)\]\(\s*(?P<url>' + URL.pattern.replace('(?i)', '') + ')')
REPOSITORY_LABEL = re.compile(r'(?i)\b(?:' + REPOSITORY_CONTEXT + r')\b')
# Words that make a nearby `owner/name` a repository rather than an identifier.
# A bare "source" is not one: "source commit/tree" is ordinary prose.
NEARBY_CONTEXT = re.compile(r'(?i)\b(?:github|repositor(?:y|ies)|repos?|forks?|forked|clones?|cloned|upstream|downstream|origin|submodules?)\b')
CONTEXT_WINDOW = 60


def explicit_references(text, path):
    found = {normalize(m.group(2)) for m in EXPLICIT_URL.finditer(text)}
    found.update(normalize(m.group(1)) for m in CONTEXT_URL.finditer(text))
    for match in LINK_URL.finditer(text):
        if REPOSITORY_LABEL.search(match['label']):
            found.update(normalize(m.group(1)) for m in URL.finditer(match['url']))
    for declaration in (*declarations(text), *commands(text)):
        found.update(normalize(m.group(1)) for m in URL.finditer(declaration))
    return found


def normalize(value):
    return value.lower().rstrip('.').removesuffix('.git')


class RepositoryObject(dict):
    """Retain duplicate JSON fields when checking explicit reference context."""
    def __init__(self, pairs):
        super().__init__(pairs)
        self.pairs = pairs


def references(text, path, local_paths=frozenset(), project_identity=None):
    stated, ambiguous = reference_sets(text, path, local_paths, project_identity)
    return stated | ambiguous


def reference_sets(text, path, local_paths=frozenset(), project_identity=None, known_owners=frozenset()):
    """Split `owner/name` tokens into stated repositories and ambiguous ones.

    URLs, qualified tokens and bare pairs with a known GitHub owner are stated
    references, as are structured declarations and repository commands. Plain
    slash prose does not acquire repository meaning from nearby words. Retain
    the private-only check for ambiguous code spans.
    """
    ambiguous = set()
    repository_text = SERVICE_URL.sub('', text)
    found = {normalize(m.group(1)) for m in URL.finditer(repository_text)
             if not SPONSORS_URL.match(repository_text, m.start())}
    for match in TOKEN.finditer(repository_text):
        # A non-ASCII slug continuation cannot turn an invalid identifier into
        # a shorter valid repository token.
        if match.end() < len(repository_text) and unicodedata.category(repository_text[match.end()])[0] in 'LMN':
            continue
        repository = normalize(match[1])
        # Unmarked prose uses canonical owner spelling. Capitalized slash
        # phrases do not become repositories just because a vendor owns one.
        known = match[1].split('/')[0] in known_owners
        logical = path in IDENTITY_FIELDS and project_identity is not None and repository == normalize(project_identity)
        if QUALIFIER.match(repository_text, match.end()) or (known and not logical):
            found.add(repository)
    # A URL in an explicit repository declaration has stronger context than
    # its coincident service spelling. Never erase the original text first.
    found.update(explicit_references(repository_text, path))
    found.update(normalize(m.group(1)) for m in DEPENDENCY.finditer(text))
    if path.lower().endswith(('.yml', '.yaml', '.md', '.markdown')):
        found.update(normalize(m.group(1)) for m in ACTION.finditer(text))
    # Repository fields avoid mistaking module IDs for repository references.
    # Markdown slash prose needs an explicit code span or repository context.
    if path.lower().endswith(('.md', '.markdown')) or path in ('@commit-message', '@tag-message'):
        markdown = URL.sub('', text)
        markdown = re.sub(r'\]\((?![A-Za-z][A-Za-z0-9+.-]*://)[^)]*\)', ']()', markdown)
        for match in MARKDOWN_REFERENCE.finditer(markdown):
            explicit = match['reference'] is not None
            value = re.split(r'[?#]', match['reference'] or match['code'], maxsplit=1)[0]
            # Underscores are also legal slug characters; remove a closing
            # emphasis marker only when the reference has its matching opener.
            emphasis = re.search(r'_+$', match['markup'] or '')
            if emphasis and value.endswith(emphasis.group()):
                value = value[:-len(emphasis.group())]
            repository = '/'.join(value.split('/')[:2])
            suffix = value[len(repository):]
            if not explicit and (value in local_paths or repository in local_paths or FILE_SUFFIX.search(repository)
                                 or repository.split('/')[0] in LOCAL_DIRECTORIES):
                continue
            # A plain multi-segment path is ambiguous; GitHub's repository
            # routes, a labeled field or a GitHub command disambiguate it.
            labeled = explicit and (re.search(r'[:=|]', match['separator']) or re.match(r'(?i)gh\s', match['label']))
            if REPOSITORY_ROUTE.match(suffix) or labeled:
                found.add(normalize(repository))
            elif not suffix:
                if explicit:
                    # An unmarked pair after a prose word such as "GitHub"
                    # is not a declaration. Code markup and clone/fork commands
                    # retain their existing repository context.
                    if not match['markup'] and not re.match(r'(?i)clone|fork', match['label']):
                        continue
                    weak = re.fullmatch(r'(?i)source', match['label']) and not re.search(r'(?i)repository|repo', markdown[match.start():match.start('reference')])
                else:
                    line_start = markdown.rfind('\n', 0, match.start()) + 1
                    around = markdown[max(line_start, match.start() - CONTEXT_WINDOW):match.end() + CONTEXT_WINDOW].split('\n', 1)[0]
                    weak = not NEARBY_CONTEXT.search(around)
                (ambiguous if weak else found).add(normalize(repository))
    elif METADATA.search(path) or SOURCE.search(path):
        if path.lower().endswith('.json'):
            try:
                document = json.loads(text, object_pairs_hook=RepositoryObject)
            except ValueError:
                document = None
            identity_field = IDENTITY_FIELDS.get(path.rsplit('/', 1)[-1])
            identity = document.get(identity_field) if isinstance(document, dict) and identity_field else None
            logical = path in ('edition.json', 'sources.lock.json', 'rer-project.json') and identity == project_identity
            if isinstance(identity, str) and FULL.fullmatch(identity) and not logical:
                found.add(normalize(identity))
            def visit(value):
                if isinstance(value, dict):
                    for key, item in value.pairs:
                        if key.lower() in ('repository', 'repo', 'github', 'sourcerepository'):
                            candidate = item.get('url') if isinstance(item, dict) else item
                            if isinstance(candidate, str) and FULL.fullmatch(candidate):
                                found.add(normalize(candidate))
                            def declared(item):
                                if isinstance(item, str):
                                    found.update(normalize(m.group(1)) for m in URL.finditer(SERVICE_URL.sub('', item)))
                                elif isinstance(item, dict):
                                    for _, child in item.pairs:
                                        declared(child)
                                elif isinstance(item, list):
                                    for child in item:
                                        declared(child)
                            declared(item)
                        visit(item)
                elif isinstance(value, list):
                    for item in value:
                        visit(item)
            visit(document)
        found.update(normalize(m.group(1)) for m in REPOSITORY_FIELD.finditer(text))
        if SOURCE.search(path):
            found.update(normalize(m.group(1)) for m in TYPED_REPOSITORY.finditer(text))
            for declaration in declarations(text):
                found.update(normalize(m.group(1)) for m in DECLARED_SHORTHAND.finditer(declaration))
    return found, ambiguous - found


def local_dependencies(data, path):
    """Cache only local-path memberships that can change this blob's meaning."""
    if not path.lower().endswith(('.md', '.markdown')):
        return frozenset()
    from hygiene_text import decoded_text
    result = set()
    for match in MARKDOWN_REFERENCE.finditer(decoded_text(data)):
        value = re.split(r'[?#]', match['reference'] or match['code'], maxsplit=1)[0]
        result.update((value, '/'.join(value.split('/')[:2])))
    return frozenset(result)


def response_object(pairs):
    document = {}
    for key, value in pairs:
        if key in document:
            raise ValueError('duplicate API response key')
        document[key] = value
    return document


def response_constant(value):
    raise ValueError('nonstandard API JSON constant')


def response(output):
    """Split `gh api --include` output into its HTTP status and strict JSON document."""
    headers, body = re.split(r'\r?\n\r?\n', output, maxsplit=1)
    status = re.fullmatch(r'HTTP/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) (\d{3})(?: [^\r\n]*)?',
                          headers.splitlines()[0])
    if not status:
        raise ValueError('no HTTP status line')
    return int(status.group(1)), json.loads(body, object_pairs_hook=response_object, parse_constant=response_constant)


def visibility(output, exit_code):
    code, document = response(output)
    if not isinstance(document, dict):
        return 'incomplete'
    if code == 200 and exit_code == 0 and type(document.get('private')) is bool:
        return 'private' if document['private'] else 'public'
    # gh exits 1 for HTTP errors. A header alone or an arbitrary error document
    # is not evidence of a missing repository, even at the intended destination.
    if (code == 404 and exit_code == 1 and document.get('message') == 'Not Found' and
            document.get('status') == '404' and isinstance(document.get('documentation_url'), str) and
            re.fullmatch(r'https://docs\.github\.com/rest/[^\s]+', document['documentation_url'])):
        return 'missing'
    return 'incomplete'


BATCH = 100
FIELDS = frozenset({'isPrivate', 'isDisabled', 'isLocked'})


def bulk_query(repositories):
    """One aliased GraphQL query; owners and names travel as variables, never as query text."""
    variables, fields, arguments = [], [], []
    for index, repository in enumerate(repositories):
        owner, name = repository.split('/')
        variables.append(f'$o{index}:String!,$n{index}:String!')
        fields.append(f'r{index}:repository(owner:$o{index},name:$n{index}){{{" ".join(sorted(FIELDS))}}}')
        arguments += ['-f', f'o{index}={owner}', '-f', f'n{index}={name}']
    return ['-f', 'query=query(' + ','.join(variables) + '){' + ' '.join(fields) + '}', *arguments]


def bulk_visibility(repositories, output, exit_code):
    """Return only the verdicts the batch states without doubt.

    A repository left out takes today's single REST lookup: a disabled or locked
    repository, an error other than GitHub's own not-found for exactly that name
    (no access through SAML or an IP allow list, a rate limit), or any response
    that is not a complete HTTP 200 GraphQL document for exactly this batch.
    """
    code, document = response(output)
    aliases = {f'r{index}': repository for index, repository in enumerate(repositories)}
    if code != 200 or not isinstance(document, dict) or not set(document) <= {'data', 'errors'}:
        return {}
    data, errors = document.get('data'), document.get('errors', [])
    # gh exits 1 exactly when the document carries errors.
    if not isinstance(data, dict) or set(data) != set(aliases) or not isinstance(errors, list) or exit_code != (1 if errors else 0):
        return {}
    reported = {}
    for error in errors:
        path = error.get('path') if isinstance(error, dict) else None
        if not (isinstance(path, list) and len(path) == 1 and path[0] in aliases):
            return {}
        reported.setdefault(path[0], []).append(error)
    states = {}
    for alias, repository in aliases.items():
        node, problems = data[alias], reported.get(alias, [])
        if (not problems and isinstance(node, dict) and set(node) == FIELDS and type(node['isPrivate']) is bool and
                node['isDisabled'] is False and node['isLocked'] is False):
            states[repository] = 'private' if node['isPrivate'] else 'public'
        elif (node is None and len(problems) == 1 and set(problems[0]) <= {'type', 'path', 'locations', 'message'} and
              problems[0].get('type') == 'NOT_FOUND' and
              problems[0].get('message') == f"Could not resolve to a Repository with the name '{repository}'."):
            states[repository] = 'missing'
    return states


def gh(arguments):
    # No disk cache, auth arguments, diagnostic output or response metadata.
    # Disable gh debug logging even if inherited from the calling shell.
    env = {k: v for k, v in os.environ.items() if k not in ('GH_DEBUG', 'DEBUG')}
    env['GH_PROMPT_DISABLED'] = '1'
    response = subprocess.run(['gh', 'api', '--hostname', 'github.com', '--include', *arguments],
                              env=env, capture_output=True, timeout=60)
    return response.stdout.decode('utf-8'), response.returncode


class GitHubResolver:
    """Verdicts for one run only: no disk cache can carry a stale or planted answer."""
    def __init__(self, spool=None):
        self.cache = {}

    def resolve_all(self, repositories):
        """Resolve in GraphQL batches; a repository its batch leaves in doubt takes the REST lookup."""
        pending = sorted(set(repositories) - self.cache.keys())
        for start in range(0, len(pending), BATCH):
            batch = pending[start:start + BATCH]
            try:
                states = bulk_visibility(batch, *gh(['graphql', *bulk_query(batch)]))
            except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
                states = {}
            for repository in batch:
                self.cache[repository] = states[repository] if repository in states else self.resolve(repository)
        return {repository: self.cache[repository] for repository in repositories}

    def resolve(self, repository):
        if repository in self.cache:
            return self.cache[repository]
        try:
            result = visibility(*gh(['repos/' + repository]))
        except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
            result = 'incomplete'
        self.cache[repository] = result
        return result
