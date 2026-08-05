# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private advisory form:
<https://github.com/Arzuparreta/soundsible/security/advisories/new>

If that is not available to you, email **rubenpenarubio02@gmail.com** with
`SECURITY` in the subject.

Please include what you can:

- what an attacker gains, and what access they need to start
- the affected version (`GET /api/health` reports it, or the About section in
  Settings)
- how it is deployed — Docker, native, desktop shell — and what sits in front
  of it
- the steps to reproduce it

Soundsible is maintained by one person. You should expect a first reply within
**five days**, and an assessment within **fourteen**. If you get nothing after
five days, assume the mail was lost and send it again.

## What is in scope

Everything published from this repository: the Station Engine and its HTTP API,
the SolidJS player, the launcher, the desktop shell, the container image, and
the Live relay in `community_service/` and `deploy/community/`.

Especially relevant, because they cross a trust boundary:

- the authentication gate in `shared/hardening.py` and `shared/api/__init__.py`,
  including scopes, session cookies, invites and paired-device tokens
- the pairing flow, agent tokens, and the owner token used by the desktop shell
- signed podcast stream tokens and the Deezer proxy allowlist
- the Live relay: session signing, artwork upload, and the MediaMTX auth hook
- the residential egress relay in `shared/relay_server.py`
- path handling anywhere audio, covers or configuration are read or written

## What is not a vulnerability

- **Exposing Soundsible to the public internet without a reverse proxy.** It is
  designed for a trusted LAN or a Tailscale network, and the docs say so. Report
  a bug in the auth gate, not the consequence of skipping it.
- **Being able to download media you have access to.** That is the product.
- **Anything requiring an already-compromised host** or an already-valid admin
  token.
- Automated scanner output with no demonstrated impact.

## Supported versions

Only the most recent release, and `edge`. There are no maintenance branches.

## Disclosure

Report privately, and give a fix a reasonable chance to ship before going
public. Fixes are released with an advisory that credits you, unless you would
rather stay anonymous.
