#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path
from history_scan import scan
from public_base import parse as parse_public_base, PublicBaseError
from report import new_report


def flag_name(value):
    # Only an option name may reach diagnostics, never an attached value or
    # control characters from an untrusted command line.
    match = re.match(r'--?[A-Za-z][A-Za-z0-9_-]*', value)
    return match.group() if match else None


TIMEOUT = json.loads(Path(__file__).with_name('timeout.json').read_text())


class SafeParser(argparse.ArgumentParser):
    def parse_args(self, args=None, namespace=None):
        parsed, unknown = self.parse_known_args(args, namespace)
        if unknown:
            flags = [name for item in unknown if (name := flag_name(item))]
            self.error('unrecognized arguments' + (': ' + ' '.join(flags) if flags else ''))
        return parsed

    def error(self, message):
        if message.startswith('ambiguous option: '):
            name = flag_name(message[len('ambiguous option: '):])
            choices = [flag for flag in self._option_string_actions if name and flag.startswith(name)]
            message = 'ambiguous option: ' + (name or '(invalid flag)') + ' could match ' + ', '.join(choices)
        elif ': ignored explicit argument ' in message:
            message = message.split(': ignored explicit argument ', 1)[0] + ': ignored explicit argument'
        report = new_report()
        report['findings'].append(dict(rule='scan.usage', path='.', commit=None, scope='newly-public',
                                       message=message, validFlags=list(self._option_string_actions)))
        print(json.dumps(report))
        self.exit(2)

    def print_help(self, file=None):
        # The worker speaks JSON; the public Node entry point renders help.
        print(json.dumps(dict(help=self.format_help())))


def seconds(value):
    try:
        result = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid timeout; expected a number greater than 0 and at most {TIMEOUT['max']}") from None
    if not 0 < result <= TIMEOUT['max']:
        raise argparse.ArgumentTypeError(f"invalid timeout; expected a number greater than 0 and at most {TIMEOUT['max']}")
    return result


def main():
    parser = SafeParser(description='Scan working files and full history with system Git and pinned Gitleaks.')
    parser.add_argument('--repo', required=True)
    parser.add_argument('--ref', default='HEAD')
    for option in ('public-base', 'env-file', 'project', 'repository', 'cache-dir', 'annotation-file'):
        parser.add_argument('--' + option)
    parser.add_argument('--timeout-seconds', type=seconds, default=TIMEOUT['default'])
    args = parser.parse_args()
    if args.public_base is not None:
        try:
            parse_public_base(args.public_base, args.repo)
        except PublicBaseError as error:
            if error.code in ('public-base.not-remote-branch', 'public-base.not-remote-url', 'public-base.not-branch-name'):
                parser.error('argument --public-base: expected <url>#<branch> with a remote URL and branch name')
    report = scan(args.repo, args.ref, args.public_base, args.env_file, args.project, args.repository,
                  cache_dir=args.cache_dir, timeout=args.timeout_seconds, annotation_file=args.annotation_file)
    print(json.dumps(report))
    return {'PASS': 0, 'FAIL': 1, 'INCOMPLETE': 2}[report['status']]


if __name__ == '__main__':
    raise SystemExit(main())
