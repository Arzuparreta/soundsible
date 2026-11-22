"""Remote control registry, validation and command dispatch."""

from shared.remote.dispatcher import send_command, transfer_playback
from shared.remote.validator import bound_track, load_registry, protocol_version, registered_commands, validate_command

__all__ = [
    "bound_track",
    "load_registry",
    "protocol_version",
    "registered_commands",
    "send_command",
    "transfer_playback",
    "validate_command",
]
