"""Classify documented JSON identities at exact native-match locations."""
from json_identity import Document
from provenance_pins import module_pins
from copy_identities import copy_pointers
from controller_metadata import controller_pointers
from source_metadata import ARCHIVE, source_pointers


def candidate(path):
    return path in ('edition.json', 'sources.lock.json', 'base-copies.json', 'base/PROVENANCE.json') or bool(ARCHIVE.fullmatch(path)) or path.endswith('.json')


class ContentIdentities:
    def __init__(self, files, read_regular=None, read_origin=None):
        self.documents, self.allowed = {}, {}
        for path, data in files.items():
            if not candidate(path):
                continue
            try:
                document = Document(data)
            except (ValueError, TypeError, IndexError, RecursionError, UnicodeError):
                continue
            self.documents[path] = document
            pointers = set(module_pins(path, document.value))
            pointers.update(source_pointers(path, document.value))
            pointers.update(controller_pointers(document.value))
            if read_regular is not None:
                pointers.update(copy_pointers(document.value, read_regular, read_origin))
            self.allowed[path] = pointers

    def matches(self, path, hit):
        document = self.documents.get(path)
        pointers = self.allowed.get(path, ())
        return bool(document and pointers and document.matches(hit, pointers))
