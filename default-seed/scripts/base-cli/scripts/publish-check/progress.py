"""Latest value-free worker observation in one private, fixed-size frame."""
from contextlib import contextmanager
import hashlib
import json
import os
import stat
from time import monotonic

FRAME_BYTES = 1024
MAX_NUMBER = 2**53 - 1
_current = None


class Progress:
    def __init__(self):
        self.started = monotonic()
        self.value = dict(lastEnteredPhase=None, lastCompletedPhase=None, observedElapsedMs=0,
                          activeOperation='none', selectedRevisions=None, publicRevisions=None,
                          historyCommits=None, publicCommits=None,
                          hydration=dict(missingBefore=None, missingAfter=None, fetches=None))

    def publish(self):
        self.value['observedElapsedMs'] = min(MAX_NUMBER, int((monotonic() - self.started) * 1000))
        body = json.dumps(self.value, separators=(',', ':'), allow_nan=False).encode()
        if len(body) > FRAME_BYTES - 65:
            return
        body = body.ljust(FRAME_BYTES - 65)
        frame = hashlib.sha256(body).hexdigest().encode() + b'\n' + body
        try:
            # fd 4 is opened by Node, passed only to this worker, and never
            # inherited by native commands. No source-controlled path is read.
            os.pwrite(4, frame, 0)
        except OSError:
            pass  # Observations cannot change scan success or refusal.


def start():
    global _current
    try:
        descriptor = os.fstat(4)
        if not stat.S_ISREG(descriptor.st_mode) or descriptor.st_size != FRAME_BYTES:
            return
    except OSError:
        return
    _current = Progress()
    enter('preparation')


def enter(phase):
    if _current:
        _current.value['lastEnteredPhase'] = phase
        _current.publish()


def completed(phase):
    if _current:
        _current.value['lastCompletedPhase'] = phase
        _current.publish()


def counts(*, hydration=False, **values):
    if _current:
        target = _current.value['hydration'] if hydration else _current.value
        target.update({key: value if type(value) is int and 0 <= value <= MAX_NUMBER else None
                       for key, value in values.items()})
        _current.publish()


@contextmanager
def operation(name):
    if not _current:
        yield
        return
    previous = _current.value['activeOperation']
    _current.value['activeOperation'] = name
    _current.publish()
    try:
        yield
    finally:
        _current.value['activeOperation'] = previous
        _current.publish()
