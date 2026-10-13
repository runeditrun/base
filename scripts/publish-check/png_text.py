"""Separate uncompressed PNG text fields from chunk framing and CRC bytes."""


def text_chunks(data):
    # Detect the container by bytes, never by a publication path or extension.
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return
    offset = 8
    while offset + 12 <= len(data):
        start = offset
        length = int.from_bytes(data[offset:offset + 4], 'big')
        end = offset + 8 + length
        if end + 4 > len(data):
            return
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:end]
        offset = end + 4
        # Checksums do not confer an exemption: inspect a framed text field
        # even if its CRC is wrong. Non-text chunks keep raw-byte inspection.
        if kind == b'tEXt':
            fields = payload.split(b'\0', 1)
            if len(fields) == 2:
                yield start, offset, [field.decode('latin-1').encode('utf-8') for field in fields]
        elif kind == b'iTXt':
            fields = payload.split(b'\0', 1)
            if len(fields) != 2 or len(fields[1]) < 2:
                continue
            keyword, body = fields
            fields = body[2:].split(b'\0', 2)
            # The compression method is ignored when the flag is zero.
            if body[0] == 0 and len(fields) == 3:
                yield start, offset, [keyword.decode('latin-1').encode('utf-8'), *fields]
        if kind == b'IEND':
            return
