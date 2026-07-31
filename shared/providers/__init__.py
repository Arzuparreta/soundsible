"""Clients for the read-only metadata services the engine browses.

Each provider owns its own pooled session and cache, so the routes that use one
do not each grow their own.
"""
