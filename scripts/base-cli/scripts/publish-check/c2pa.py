"""Certificate metadata inside a PNG's C2PA manifest store (caBX chunk).

Image generators sign a C2PA manifest and embed the signing certificate chain
in it; a certificate names its holder, often by address. Only values that a
strict X.509 parse places in an issuer or subject Name, or in a subject or
issuer alternative name's rfc822Name, are certificate metadata. Every other
byte of the manifest, assertions included, remains text to inspect.
"""
from der import OID, SEQUENCE, BIT_STRING, rdn_values, tlv

INTEGER, OCTET_STRING, VERSION, EXTENSIONS, RFC822_NAME = 0x02, 0x04, 0xA0, 0xA3, 0x81
ALTERNATIVE_NAMES = (bytes.fromhex('551d11'), bytes.fromhex('551d12'))


def manifest_payloads(data):
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return
    offset = 8
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind, start, end = data[offset + 4:offset + 8], offset + 8, offset + 8 + length
        if end + 4 > len(data):
            return
        if kind == b'caBX':
            yield start, end
        if kind == b'IEND':
            return
        offset = end + 4


def name_values(data, name):
    # A Name is RDN SETs filling its SEQUENCE exactly.
    values, cursor = [], name[1]
    while cursor < name[2]:
        rdn = rdn_values(data, cursor, name[2])
        if not rdn:
            return None
        cursor, found = rdn
        values += found
    return values


def alternative_names(data, extensions):
    spans, outer = [], tlv(data, extensions[1], extensions[2])
    if not outer or outer[0] != SEQUENCE or outer[2] != extensions[2]:
        return None
    cursor = outer[1]
    while cursor < outer[2]:
        extension = tlv(data, cursor, outer[2])
        oid = extension and extension[0] == SEQUENCE and tlv(data, extension[1], extension[2])
        if not oid or oid[0] != OID:
            return None
        value = tlv(data, oid[2], extension[2])
        if value and value[0] == 0x01:
            value = tlv(data, value[2], extension[2])
        if not value or value[0] != OCTET_STRING or value[2] != extension[2]:
            return None
        if data[oid[1]:oid[2]] in ALTERNATIVE_NAMES:
            general = tlv(data, value[1], value[2])
            if not general or general[0] != SEQUENCE:
                return None
            entry = general[1]
            while entry < general[2]:
                item = tlv(data, entry, general[2])
                if not item:
                    return None
                if item[0] == RFC822_NAME:
                    spans.append((item[1], item[2]))
                entry = item[2]
        cursor = extension[2]
    return spans


def certificate(data, offset, end):
    """Name and alternative-name value spans of one X.509 Certificate, or None."""
    outer = tlv(data, offset, end)
    if not outer or outer[0] != SEQUENCE:
        return None
    tbs = tlv(data, outer[1], outer[2])
    algorithm = tbs and tbs[0] == SEQUENCE and tlv(data, tbs[2], outer[2])
    signature = algorithm and algorithm[0] == SEQUENCE and tlv(data, algorithm[2], outer[2])
    if not signature or signature[0] != BIT_STRING or signature[2] != outer[2]:
        return None
    fields, cursor = [], tbs[1]
    while cursor < tbs[2]:
        field = tlv(data, cursor, tbs[2])
        if not field:
            return None
        fields.append(field)
        cursor = field[2]
    if fields and fields[0][0] == VERSION:
        fields = fields[1:]
    # serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.
    if len(fields) < 6 or [field[0] for field in fields[:6]] != [INTEGER] + [SEQUENCE] * 5:
        return None
    issuer, subject = name_values(data, fields[2]), name_values(data, fields[4])
    if issuer is None or subject is None:
        return None
    spans = issuer + subject
    for field in fields[6:]:
        if field[0] == EXTENSIONS:
            names = alternative_names(data, field)
            if names is None:
                return None
            spans += names
    return spans


def certificate_spans(data):
    """Value spans of the certificates a PNG's C2PA manifest store carries."""
    spans = []
    for start, end in manifest_payloads(data):
        offset = data.find(SEQUENCE.to_bytes(1, 'big'), start, end)
        while 0 <= offset < end:
            found = certificate(data, offset, end)
            if found is None:
                offset = data.find(SEQUENCE.to_bytes(1, 'big'), offset + 1, end)
                continue
            spans += found
            offset = data.find(SEQUENCE.to_bytes(1, 'big'), tlv(data, offset, end)[2], end)
    return spans
