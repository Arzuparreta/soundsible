"""The blueprint the discovery routes share.

It lives on its own so the four modules that attach routes to it — settings and
feedback, the music feed, Auto Mode and the DJ engine, the podcast directory —
can import it without importing each other.
"""

from flask import Blueprint

discovery_bp = Blueprint("discovery", __name__, url_prefix="")
