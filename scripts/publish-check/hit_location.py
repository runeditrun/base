"""Resolve a native Gitleaks hit to its possible full-match byte spans."""


def match_spans(data, hit):
    try:
        # Gitleaks counts LF bytes, not Python's broader set of line breaks.
        lines = data.split(b'\n')
        first, last = hit['StartLine'] - 1, hit['EndLine'] - 1
        if not (0 <= first <= last < len(lines)):
            return []
        match = hit['Match'].encode('utf-8')
        if not match:
            return []
        left = sum(len(line) + 1 for line in lines[:first])
        right = left + sum(len(line) + 1 for line in lines[first:last + 1])
        # Directory fragments can start mid-line. Their columns are relative
        # to that fragment, whose starting column is absent from the report.
        # Later fragment lines also count the preceding LF in their columns.
        # Bind the full match within the reported lines instead. Even an
        # apparently exact column cannot disambiguate repeated occurrences.
        # Callers must prove every candidate, never just the first one.
        spans = []
        start = data.find(match, left, right)
        while start >= 0:
            spans.append((start, start + len(match)))
            start = data.find(match, start + 1, right)
        return spans
    except (KeyError, TypeError, IndexError, UnicodeError):
        return []
