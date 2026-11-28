"""Forward an upstream audio response to a streaming client."""

from collections.abc import Iterator

from requests import Response


def iter_audio_chunks(response: Response) -> Iterator[bytes]:
    """Return the connection to the pool even when a client abandons a range."""
    try:
        for chunk in response.iter_content(chunk_size=65536):
            if chunk:
                yield chunk
    finally:
        response.close()
