"""Recognise binary image and video files by their container structure.

A file is media only when its bytes walk as one complete container, from the
signature to the end of the file, allowing only NUL padding after it. The path
and extension never decide, so text renamed .gif, or a valid image with text
appended, is not media. Anything that does not walk keeps today's inspection.
Each walker returns where its container ends, or None.
"""


def gif(data):
    if data[:6] not in (b'GIF87a', b'GIF89a') or len(data) < 13:
        return None
    offset = 13 + ((3 << ((data[10] & 7) + 1)) if data[10] & 0x80 else 0)
    while offset < len(data):
        kind = data[offset]
        if kind == 0x3B:
            return offset + 1
        if kind == 0x21:
            offset += 2
        elif kind == 0x2C:
            if offset + 10 > len(data):
                return None
            flags = data[offset + 9]
            offset += 10 + ((3 << ((flags & 7) + 1)) if flags & 0x80 else 0) + 1
        else:
            return None
        # Data sub-blocks: a length byte, that many bytes, ending at length zero.
        while True:
            if offset >= len(data):
                return None
            size = data[offset]
            offset += 1 + size
            if not size:
                break
    return None


def png(data):
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return None
    offset = 8
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        offset += 12 + length
        if kind == b'IEND':
            return offset
    return None


def jpeg(data):
    if not data.startswith(b'\xff\xd8'):
        return None
    offset = 2
    while offset + 2 <= len(data):
        if data[offset] != 0xFF:
            return None
        marker = data[offset + 1]
        if marker == 0xFF:
            offset += 1
            continue
        if marker == 0xD9:
            return offset + 2
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            offset += 2
            continue
        if offset + 4 > len(data):
            return None
        offset += 2 + int.from_bytes(data[offset + 2:offset + 4], 'big')
        if marker == 0xDA:
            # Entropy-coded data runs to the next marker other than a stuffed
            # zero or a restart marker.
            while True:
                offset = data.find(b'\xff', offset)
                if offset < 0 or offset + 1 >= len(data):
                    return None
                if data[offset + 1] == 0 or 0xD0 <= data[offset + 1] <= 0xD7:
                    offset += 2
                else:
                    break
    return None


def webp(data):
    if len(data) < 20 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return None
    end = int.from_bytes(data[4:8], 'little') + 8
    offset = 12
    while offset + 8 <= end:
        size = int.from_bytes(data[offset + 4:offset + 8], 'little')
        offset += 8 + size + (size & 1)
    return end if offset == end else None


def iso_media(data):
    # MP4 and AVIF share ISO base media boxes, opened by a file-type box.
    if data[4:8] != b'ftyp':
        return None
    offset = 0
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], 'big')
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return None
            size, header = int.from_bytes(data[offset + 8:offset + 16], 'big'), 16
        elif size == 0:
            size = len(data) - offset
        if size < header:
            return None
        offset += size
    return offset if offset == len(data) else None


def ebml_number(data, offset, marker):
    # A variable-length EBML number; the marker bit stays in IDs, not sizes.
    if offset >= len(data) or not data[offset]:
        return None, offset
    length = 9 - data[offset].bit_length()
    if offset + length > len(data):
        return None, offset
    value = int.from_bytes(data[offset:offset + length], 'big')
    if not marker:
        value &= (1 << (7 * length)) - 1
        if value == (1 << (7 * length)) - 1:
            value = -1
    return value, offset + length


def webm(data):
    if not data.startswith(b'\x1a\x45\xdf\xa3') or b'webm' not in data[:64]:
        return None
    offset = 0
    while offset < len(data):
        element, offset = ebml_number(data, offset, True)
        size, offset = ebml_number(data, offset, False)
        if element is None or size is None:
            return None
        # Only a live Segment may leave its size unknown: it runs to the end.
        if size == -1:
            if element != 0x18538067:
                return None
            size = len(data) - offset
        offset += size
    return offset if offset == len(data) else None


def ico(data):
    if len(data) < 6 or data[:4] != b'\0\0\1\0':
        return None
    count = int.from_bytes(data[4:6], 'little')
    images = []
    for index in range(count):
        entry = 6 + 16 * index
        if entry + 16 > len(data):
            return None
        images.append((int.from_bytes(data[entry + 12:entry + 16], 'little'),
                       int.from_bytes(data[entry + 8:entry + 12], 'little')))
    # Image data follows the directory with no gap.
    offset = 6 + 16 * count
    for start, size in sorted(images):
        if start != offset or not size:
            return None
        offset += size
    return offset if count else None


FORMATS = (gif, png, jpeg, webp, iso_media, webm, ico)


def binary_media(data):
    for walk in FORMATS:
        end = walk(data)
        if end is not None and end <= len(data) and not data[end:].strip(b'\0'):
            return True
    return False
