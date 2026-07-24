"""
Account administration from the shell: ``python run.py --users <command>``.

A headless install has no browser and, right after migrating, no password on
the account that inherited the library. This is the deterministic way to get
from "the service is running" to "everyone has their own login" — and the way
back in when somebody forgets a password.

Every command works directly against ``instance.db``; nothing here goes through
HTTP, so it does not need an account to already be usable.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from typing import Optional, Sequence

from shared.multiuser_migration import ensure_multiuser_layout
from shared.users import (
    ROLE_ADMIN,
    ROLE_MEMBER,
    UserError,
    create_invite,
    create_user,
    delete_user,
    get_user_by_username,
    instance_requires_login,
    list_invites,
    list_users,
    revoke_user_sessions,
    set_disabled,
    set_password,
    update_user,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run.py --users",
        description="Manage Soundsible accounts.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="Show every account.")

    create = sub.add_parser("create", help="Create an account.")
    create.add_argument("username")
    create.add_argument("--password", help="Prompted for when omitted.")
    create.add_argument("--display-name")
    create.add_argument("--admin", action="store_true", help="Create as an admin.")

    invite = sub.add_parser("invite", help="Mint a one-time invitation link.")
    invite.add_argument("--display-name", help="Name to greet the person by.")
    invite.add_argument("--base-url", help="Address they can reach, e.g. http://100.85.98.18:5005")
    invite.add_argument("--admin", action="store_true", help="Invite as an admin.")

    sub.add_parser("invites", help="List invitations.")

    passwd = sub.add_parser("passwd", help="Set an account's password.")
    passwd.add_argument("username")
    passwd.add_argument("--password", help="Prompted for when omitted.")

    rename = sub.add_parser("rename", help="Change username and/or display name.")
    rename.add_argument("username")
    rename.add_argument("--to", help="New username.")
    rename.add_argument("--display-name", help="New display name.")

    role = sub.add_parser("role", help="Change an account's role.")
    role.add_argument("username")
    role.add_argument("role", choices=[ROLE_ADMIN, ROLE_MEMBER])

    disable = sub.add_parser("disable", help="Disable an account (keeps its data).")
    disable.add_argument("username")

    enable = sub.add_parser("enable", help="Re-enable a disabled account.")
    enable.add_argument("username")

    logout = sub.add_parser("logout", help="Revoke every live session for an account.")
    logout.add_argument("username")

    delete = sub.add_parser("delete", help="Delete an account and its library.")
    delete.add_argument("username")
    delete.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")

    return parser


def _resolve(username: str) -> dict:
    user = get_user_by_username(username)
    if not user:
        raise UserError(f"No account named {username!r}.")
    return user


def _ask_password(supplied: Optional[str]) -> str:
    if supplied:
        return supplied
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Repeat: ")
    if first != second:
        raise UserError("Passwords do not match.")
    return first


def _print_users() -> None:
    rows = list_users()
    if not rows:
        print("No accounts yet.")
        return
    width = max(len(r["username"]) for r in rows)
    for row in rows:
        flags = []
        if row["role"] == ROLE_ADMIN:
            flags.append("admin")
        if not row["has_password"]:
            flags.append("no password")
        if row["disabled"]:
            flags.append("disabled")
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        print(f"  {row['username']:<{width}}  {row['display_name']}{suffix}")
    print()
    print(f"Login required: {'yes' if instance_requires_login() else 'no'}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(list(argv or []))

    # Safe to call every time: it creates the first account only when there is
    # none, and adopts a pre-multiuser library if one is lying around.
    ensure_multiuser_layout()

    try:
        if args.command == "list":
            _print_users()

        elif args.command == "create":
            user = create_user(
                args.username,
                password=_ask_password(args.password),
                display_name=args.display_name,
                role=ROLE_ADMIN if args.admin else ROLE_MEMBER,
            )
            print(f"Created {user['username']} ({user['role']}).")
            if instance_requires_login():
                print("Everyone now needs to sign in.")

        elif args.command == "invite":
            token, invite = create_invite(
                display_name=args.display_name,
                role=ROLE_ADMIN if args.admin else ROLE_MEMBER,
            )
            base = (args.base_url or "").rstrip("/")
            link = f"{base}/player/#/invite/{token}" if base else None
            print(f"Invitation created (expires {invite['expires_at']}).")
            if link:
                print(f"\n  {link}\n")
            else:
                print(f"\n  token: {token}")
                print("  Pass --base-url to get a ready-to-send link.\n")
            print("Single use. They choose their own username and password.")

        elif args.command == "invites":
            rows = list_invites()
            if not rows:
                print("No invitations.")
            for row in rows:
                state = "used" if row["used"] else "revoked" if row["revoked"] else "open"
                name = row["display_name"] or "—"
                print(f"  {row['id'][:8]}  {name:<20} {state:<8} expires {row['expires_at']}")

        elif args.command == "passwd":
            user = _resolve(args.username)
            set_password(user["id"], _ask_password(args.password))
            print(f"Password updated for {user['username']}. Their other sessions were signed out.")

        elif args.command == "rename":
            user = _resolve(args.username)
            updated = update_user(
                user["id"],
                username=args.to,
                display_name=args.display_name,
            )
            print(f"Now: {updated['username']} ({updated['display_name']}).")

        elif args.command == "role":
            user = _resolve(args.username)
            updated = update_user(user["id"], role=args.role)
            print(f"{updated['username']} is now {updated['role']}.")

        elif args.command in ("disable", "enable"):
            user = _resolve(args.username)
            updated = set_disabled(user["id"], args.command == "disable")
            print(f"{updated['username']} is {'disabled' if updated['disabled'] else 'active'}.")

        elif args.command == "logout":
            user = _resolve(args.username)
            print(f"Revoked {revoke_user_sessions(user['id'])} session(s) for {user['username']}.")

        elif args.command == "delete":
            user = _resolve(args.username)
            if not args.yes:
                answer = input(
                    f"Delete {user['username']} and their library, playlists and history? [y/N] "
                )
                if answer.strip().lower() not in ("y", "yes"):
                    print("Cancelled.")
                    return 1
            delete_user(user["id"])
            print(f"Deleted {user['username']}. Shared music files were left on disk.")

    except UserError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    return 0
