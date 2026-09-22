"""Hash the normal compact Flask body without retaining its full JSON copy."""
from hashlib import sha256

from flask import current_app
from flask.json.provider import DefaultJSONProvider


TRACK_BATCH_SIZE = 500


def compact_signature(payload, account):
    """Return (ETag digest, byte length), or None for other JSON providers.

    This must match jsonify(payload) byte for byte, including its trailing
    newline. Only the standard compact provider is optimized; custom/pretty
    serializers keep Flask's normal response path. Scratch JSON is bounded by
    a track batch or one top-level header, not the complete track collection.
    """
    provider = current_app.json
    if type(provider) is not DefaultJSONProvider:
        return None
    if provider.compact is False or (provider.compact is None and current_app.debug):
        return None

    digest = sha256(account.encode() + b'\0')
    size = 0

    def consume(data):
        nonlocal size
        digest.update(data)
        size += len(data)

    def encode(value):
        return provider.dumps(value, separators=(',', ':')).encode('utf-8')

    consume(b'{')
    keys = sorted(payload) if provider.sort_keys else payload
    for index, key in enumerate(keys):
        if index:
            consume(b',')
        consume(encode(key))
        consume(b':')
        value = payload[key]
        if key == 'tracks':
            consume(b'[')
            for offset in range(0, len(value), TRACK_BATCH_SIZE):
                if offset:
                    consume(b',')
                # Flask's C JSON encoder handles a small batch at a time.
                # Strip only this batch's outer brackets; nested data is intact.
                consume(encode(value[offset:offset + TRACK_BATCH_SIZE])[1:-1])
            consume(b']')
        else:
            consume(encode(value))
    consume(b'}\n')
    return digest.hexdigest(), size
