"""Find the pixel and sample data inside an image or video file.

A file is media only when its bytes walk as one complete container, from the
signature to the end of the file, allowing only NUL padding after it. The path
and extension never decide, so text renamed .gif, or a valid image with text
appended, is not media. Each walker returns where its container ends and the
(start, end) spans of its pixel or sample data (compressed samples and colour
tables), or None. Everything outside those spans, such as comments, XMP and
tags, is still text to inspect.
"""


def gif(data):
    if data[:6] not in (b'GIF87a', b'GIF89a') or len(data) < 13:
        return None
    # Colour tables are pixel data too: palette bytes can spell an address.
    offset = 13 + ((3 << ((data[10] & 7) + 1)) if data[10] & 0x80 else 0)
    samples = [(13, offset)]
    while offset < len(data):
        kind = data[offset]
        if kind == 0x3B:
            return offset + 1, samples
        if kind == 0x21:
            offset += 2
        elif kind == 0x2C:
            if offset + 10 > len(data):
                return None
            flags = data[offset + 9]
            # Descriptor, local colour table, then the LZW minimum code size.
            table = offset + 10 + ((3 << ((flags & 7) + 1)) if flags & 0x80 else 0)
            samples.append((offset + 10, table))
            offset = table + 1
        else:
            return None
        # Data sub-blocks: a length byte, that many bytes, ending at length zero.
        start = offset
        while True:
            if offset >= len(data):
                return None
            size = data[offset]
            offset += 1 + size
            if not size:
                break
        if kind == 0x2C:
            samples.append((start, offset))
    return None


def png(data):
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return None
    offset = 8
    samples = []
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        if kind in (b'PLTE', b'IDAT', b'fdAT'):
            samples.append((offset + 8, offset + 8 + length))
        offset += 12 + length
        if kind == b'IEND':
            return offset, samples
    return None


def jpeg(data):
    # A phone stores more images after the first one's end (MPF depth and
    # gain maps): each is walked, and their samples are pixels too.
    walked = jpeg_image(data, 0)
    if walked is None:
        return None
    end, samples = walked
    while data.startswith(b'\xff\xd8', end) and (following := jpeg_image(data, end)):
        end, more = following
        samples += more
    return end, samples


def jpeg_image(data, offset):
    if not data.startswith(b'\xff\xd8', offset):
        return None
    offset += 2
    samples = []
    while offset + 2 <= len(data):
        if data[offset] != 0xFF:
            return None
        marker = data[offset + 1]
        if marker == 0xFF:
            offset += 1
            continue
        if marker == 0xD9:
            return offset + 2, samples
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            offset += 2
            continue
        if offset + 4 > len(data):
            return None
        offset += 2 + int.from_bytes(data[offset + 2:offset + 4], 'big')
        if marker == 0xDA:
            # Entropy-coded data runs to the next marker other than a stuffed
            # zero or a restart marker.
            start = offset
            while True:
                offset = data.find(b'\xff', offset)
                if offset < 0 or offset + 1 >= len(data):
                    return None
                if data[offset + 1] == 0 or 0xD0 <= data[offset + 1] <= 0xD7:
                    offset += 2
                else:
                    break
            samples.append((start, offset))
    return None


WEBP_SAMPLES = (b'VP8 ', b'VP8L', b'ALPH', b'ANMF')


def webp(data):
    if len(data) < 20 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return None
    end = int.from_bytes(data[4:8], 'little') + 8
    offset = 12
    samples = []
    while offset + 8 <= end:
        size = int.from_bytes(data[offset + 4:offset + 8], 'little')
        if data[offset:offset + 4] in WEBP_SAMPLES:
            samples.append((offset + 8, offset + 8 + size))
        offset += 8 + size + (size & 1)
    return (end, samples) if offset == end else None


# Major brands of MP4, QuickTime, 3GPP and HEIF/AVIF files.
ISO_BRANDS = {b'isom', b'iso2', b'iso4', b'iso5', b'iso6', b'mp41', b'mp42', b'avc1', b'dash',
              b'M4V ', b'M4A ', b'M4VH', b'M4VP', b'qt  ', b'3gp4', b'3gp5', b'3gp6', b'3g2a',
              b'mif1', b'msf1', b'avif', b'avis', b'heic', b'heix', b'heim', b'heis', b'hevc', b'hevx'}


def iso_media(data):
    # MP4 and AVIF share ISO base media boxes, opened by a file-type box with
    # an explicit size and a known major brand.
    if len(data) < 16 or data[4:8] != b'ftyp' or data[8:12] not in ISO_BRANDS:
        return None
    if int.from_bytes(data[:4], 'big') < 16:
        return None
    offset = 0
    kinds, samples = set(), []
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return None
            size, header = int.from_bytes(data[offset + 8:offset + 16], 'big'), 16
        elif size == 0:
            # Only a last box after the file type may run to the end.
            size = len(data) - offset
        if size < header:
            return None
        kinds.add(kind)
        if kind == b'mdat':
            samples.append((offset + header, offset + size))
        offset += size
    # A movie has its moov box; a still image (HEIF/AVIF) has meta.
    if offset != len(data) or not kinds & {b'moov', b'meta'}:
        return None
    return offset, samples


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


SEGMENT = 0x18538067
CLUSTER = 0x1F43B675
# Segment children: a Cluster of unknown size ends at the next one of these.
SEGMENT_CHILDREN = {CLUSTER, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1C53BB6B,
                    0x1941A469, 0x1043A770, 0x1254C367}


def ebml_element(data, offset):
    element, content = ebml_number(data, offset, True)
    size, content = ebml_number(data, content, False)
    return element, content, size


def open_cluster(data, offset, end):
    # A live Cluster of unknown size runs to the next Segment child.
    start = offset
    while offset < end:
        element, content, size = ebml_element(data, offset)
        if element in SEGMENT_CHILDREN:
            break
        if element is None or size is None or size == -1:
            return None
        offset = content + size
    return offset - start


def webm_segment(data, offset, end):
    # Each Cluster's blocks are the samples; other Segment children are not.
    samples = []
    while offset < end:
        element, content, size = ebml_element(data, offset)
        if element is None or size is None:
            return None
        if size == -1:
            size = open_cluster(data, content, end) if element == CLUSTER else None
            if size is None:
                return None
        if element == CLUSTER:
            samples.append((content, content + size))
        offset = content + size
    return samples if offset == end else None


def webm(data):
    if not data.startswith(b'\x1a\x45\xdf\xa3') or b'webm' not in data[:64]:
        return None
    offset, samples = 0, []
    while offset < len(data):
        element, content, size = ebml_element(data, offset)
        if element is None or size is None:
            return None
        # Only a live Segment may leave its size unknown: it runs to the end.
        if size == -1:
            if element != SEGMENT:
                return None
            size = len(data) - content
        if element == SEGMENT:
            segment = webm_segment(data, content, content + size)
            if segment is None:
                return None
            samples += segment
        offset = content + size
    return (offset, samples) if offset == len(data) else None


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
    # Image data follows the directory with no gap. An embedded PNG keeps its
    # own compressed samples; bitmap pixels are stored as they are.
    offset = 6 + 16 * count
    samples = []
    for start, size in sorted(images):
        if start != offset or not size:
            return None
        image = png(data[start:start + size])
        if image and image[0] == size:
            samples += [(start + a, start + b) for a, b in image[1]]
        offset += size
    return (offset, samples) if count else None


FORMATS = (gif, png, jpeg, webp, iso_media, webm, ico)


def sample_spans(data):
    """The pixel and sample spans of a complete media file, or None."""
    for walk in FORMATS:
        walked = walk(data)
        if walked and walked[0] <= len(data) and not data[walked[0]:].strip(b'\0'):
            return [(start, min(end, walked[0])) for start, end in walked[1]]
    return None
