"""Classify documented JSON identities at exact native-match locations."""
from json_identity import Document
from provenance_pins import module_pins
from copy_adaptations import adaptation_pointers
from copy_identities import copy_pointers
from controller_metadata import controller_pointers
from source_metadata import ARCHIVE, source_pointers


def candidate(path):
    return path in ('edition.json', 'sources.lock.json', 'base-copies.json', 'base/PROVENANCE.json') or bool(ARCHIVE.fullmatch(path)) or path.endswith('.json')


class ContentIdentities:
    def __init__(self, files, read_regular=None, read_origin=None):
        self.documents, self.allowed = {}, {}
        self.read_regular, self.read_origin = read_regular, read_origin
        self.adaptations = None
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
                pointers.update(copy_pointers(document.value, read_regular))
            self.allowed[path] = pointers

    def matches(self, path, hit):
        document = self.documents.get(path)
        if document is None:
            return False
        allowed = self.allowed[path]
        if document.matches(hit, allowed):
            return True
        if path != 'base-copies.json' or self.read_regular is None or self.read_origin is None:
            return False
        if self.adaptations is None:
            self.adaptations = adaptation_pointers(document.value, self.read_regular, self.read_origin)
        return bool(self.adaptations and document.matches(hit, allowed | self.adaptations))
