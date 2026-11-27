"""Pure parsers for timed lyrics formats (LRC, TTML, NetEase YRC, LyricsPlus JSON).

No network or database access. Produces compact structured ``rich_synced``
payloads (``{"granularity": "syllable"|"word", "lines": [...], "dur"?: int}``)
plus line-level LRC and plain text derived from the same parse.
"""

from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, Optional

_SPACE_RE = re.compile(r"\s+")
_ALNUM_RE = re.compile(r"[\w]", re.UNICODE)
_LRC_TIMESTAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_YRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_YRC_SEG_RE = re.compile(r"\((\d+),(\d+),\d+\)([^(]*)")
_NETEASE_CREDIT_RE = re.compile(
    r"^\s*(作词|作曲|编曲|制作人|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|词|曲|监制|出品|统筹|策划|宣传|发行)\s*[:：]"
)


def parse_lrc(text: str) -> list[tuple[int, str]]:
    """LRC text as ``(offset in milliseconds, line)``, in time order."""
    lines: list[tuple[int, str]] = []
    for raw in str(text or "").splitlines():
        stamps = list(_LRC_TIMESTAMP.finditer(raw))
        if not stamps:
            continue
        content = raw[stamps[-1].end():].strip()
        for stamp in stamps:
            minutes, seconds, fraction = stamp.groups()
            millis = int((fraction or "0").ljust(3, "0")[:3]) if fraction else 0
            lines.append((int(minutes) * 60_000 + int(seconds) * 1000 + millis, content))
    return sorted(lines, key=lambda entry: entry[0])


def parse_rich_synced(value: Any) -> Optional[Dict[str, Any]]:
    """Decode a stored ``rich_synced`` JSON string or pass through a valid dict."""
    if not value:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if not isinstance(value, dict) or not isinstance(value.get("lines"), list) or not value["lines"]:
        return None
    return value


def _stamp_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("ms"):
        sec = float(text[:-2]) / 1000.0
    else:
        text = text[:-1] if text.endswith("s") else text
        parts = text.split(":")
        if len(parts) > 3:
            raise ValueError("Unsupported timestamp")
        sec = sum(float(part) * (60 ** power) for power, part in enumerate(reversed(parts)))
    if not math.isfinite(sec) or sec < 0:
        raise ValueError("Invalid timestamp")
    return int(round(sec * 1000))


def _format_lrc_stamp(ms: int) -> str:
    total_cs = max(0, int(round(ms / 10.0)))
    minutes, rem = divmod(total_cs, 6000)
    seconds, centis = divmod(rem, 100)
    return f"[{minutes:02d}:{seconds:02d}.{centis:02d}]"


def _classify_granularity(lines: list[Dict[str, Any]]) -> str:
    """Return ``"syllable"``, ``"word"``, or ``"line"`` from structured lines."""
    word_segments = 0
    syllable_splits = 0
    for line in lines:
        segs = line.get("s") or []
        if len({(seg["t"], seg["e"]) for seg in segs}) < 2:
            continue
        word_segments += len(segs)
        for a, b in zip(segs, segs[1:]):
            t1, t2 = a["x"], b["x"]
            if t1 and t2 and not t1[-1].isspace() and not t2[0].isspace() and _ALNUM_RE.search(t1) and _ALNUM_RE.search(t2):
                syllable_splits += 1
    if syllable_splits >= 2:
        return "syllable"
    return "word" if word_segments > 0 else "line"


def _finalize_rich(lines: list[Dict[str, Any]], duration: Optional[int]) -> Optional[Dict[str, Any]]:
    lines.sort(key=lambda item: (item["t"], 1 if item.get("bg") else 0))
    granularity = _classify_granularity(lines)
    if granularity not in {"syllable", "word"}:
        return None
    rich: Dict[str, Any] = {"granularity": granularity, "lines": lines}
    if duration:
        rich["dur"] = int(duration)
    return rich


def _lines_to_lrc_and_plain(lines: list[Dict[str, Any]]) -> tuple[Optional[str], Optional[str]]:
    lrc: list[str] = []
    plain: list[str] = []
    for line in lines:
        if line.get("bg"):
            continue
        text = _SPACE_RE.sub(" ", "".join(seg["x"] for seg in line["s"])).strip()
        if not text:
            continue
        lrc.append(f"{_format_lrc_stamp(line['t'])}{text}")
        plain.append(text)
    return ("\n".join(lrc) or None), ("\n".join(plain) or None)


def _ttml_role(element: ET.Element) -> Optional[str]:
    return next((v for k, v in element.attrib.items() if k.endswith("role")), None)


def _ttml_spans_to_segments(spans: list[tuple[int, int, str, str]]) -> list[Dict[str, Any]]:
    segs: list[Dict[str, Any]] = []
    last = len(spans) - 1
    for idx, (b_ms, e_ms, txt, tail) in enumerate(spans):
        clean = _SPACE_RE.sub(" ", txt)
        if idx == 0:
            clean = clean.lstrip()
        if idx == last:
            clean = clean.rstrip()
        elif tail[:1].isspace() and not clean.endswith(" "):
            clean += " "
        if clean:
            segs.append({"t": b_ms, "e": max(e_ms, b_ms), "x": clean})
    return segs


def parse_ttml(body: str, duration: Optional[int] = None) -> tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """Parse TTML into ``(line_lrc, plain_text, rich_synced_or_none)``.

    Preserves intra-word syllable splits (adjacent timed ``<span>`` elements
    with no intervening whitespace), separates ``ttm:role="x-bg"`` background
    vocals into their own lines, and skips translations/romanizations.
    """
    raw = str(body or "")
    if not raw.strip():
        return None, None, None
    upper = raw.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        raise ValueError("Unsafe XML declaration")
    root = ET.fromstring(raw)

    rich_lines: list[Dict[str, Any]] = []
    untimed_plain: list[str] = []

    def walk_spans(parent: ET.Element, target: list[tuple[int, int, str, str]], bg_out: list[list[tuple[int, int, str, str]]]) -> None:
        for child in parent:
            if child.tag.rsplit("}", 1)[-1] != "span":
                continue
            role = _ttml_role(child)
            if role in {"x-translation", "x-roman"}:
                continue
            if role == "x-bg":
                bg_spans: list[tuple[int, int, str, str]] = []
                walk_spans(child, bg_spans, [])
                if not bg_spans:
                    b_bg, e_bg = _stamp_ms(child.get("begin")), _stamp_ms(child.get("end"))
                    txt_bg = _SPACE_RE.sub(" ", "".join(child.itertext())).strip()
                    if b_bg is not None and txt_bg:
                        bg_spans = [(b_bg, e_bg if (e_bg is not None and e_bg > b_bg) else b_bg + 2000, txt_bg, "")]
                if bg_spans:
                    bg_out.append(bg_spans)
                continue
            b_ms, e_ms = _stamp_ms(child.get("begin")), _stamp_ms(child.get("end"))
            if b_ms is not None and e_ms is not None:
                txt = "".join(child.itertext())
                if txt.strip():
                    target.append((b_ms, max(e_ms, b_ms), txt, child.tail or ""))
            else:
                walk_spans(child, target, bg_out)

    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] != "p":
            continue
        p_begin, p_end = _stamp_ms(el.get("begin")), _stamp_ms(el.get("end"))
        main_spans: list[tuple[int, int, str, str]] = []
        bg_groups: list[list[tuple[int, int, str, str]]] = []
        walk_spans(el, main_spans, bg_groups)

        if main_spans:
            segs = _ttml_spans_to_segments(main_spans)
            if segs:
                start = p_begin if p_begin is not None else segs[0]["t"]
                end = p_end if (p_end is not None and p_end >= start) else max(s["e"] for s in segs)
                rich_lines.append({"t": start, "e": max(end, start), "s": segs})
        else:
            parts = [el.text or ""] + [
                ("".join(c.itertext()) if _ttml_role(c) not in {"x-translation", "x-roman", "x-bg"} else "") + (c.tail or "")
                for c in el
            ]
            text = _SPACE_RE.sub(" ", "".join(parts)).strip()
            if p_begin is not None and text:
                end = p_end if (p_end is not None and p_end >= p_begin) else p_begin + 3000
                rich_lines.append({"t": p_begin, "e": end, "s": [{"t": p_begin, "e": end, "x": text}]})
            elif text:
                untimed_plain.append(text)

        for bg_spans in bg_groups:
            bg_segs = _ttml_spans_to_segments(bg_spans)
            if bg_segs:
                rich_lines.append({"t": bg_segs[0]["t"], "e": max(s["e"] for s in bg_segs), "bg": True, "s": bg_segs})

    if not rich_lines:
        return None, ("\n".join(untimed_plain) or None), None
    rich = _finalize_rich(rich_lines, duration)
    synced, plain = _lines_to_lrc_and_plain(rich_lines)
    return synced, plain, rich


def parse_yrc(body: str, duration: Optional[int] = None) -> tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """Parse NetEase YRC into ``(line_lrc, plain_text, rich_synced_or_none)``."""
    rich_lines: list[Dict[str, Any]] = []
    for raw in str(body or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("{"):
            continue
        match = _YRC_LINE_RE.match(line)
        if not match:
            continue
        line_start, line_dur = int(match.group(1)), int(match.group(2))
        raw_segs = list(_YRC_SEG_RE.finditer(match.group(3)))
        plain_line = _SPACE_RE.sub(" ", "".join(m.group(3) for m in raw_segs)).strip()
        if not plain_line or _NETEASE_CREDIT_RE.match(plain_line):
            continue
        segs: list[Dict[str, Any]] = []
        last = len(raw_segs) - 1
        for idx, seg_m in enumerate(raw_segs):
            text = seg_m.group(3)
            if idx == 0:
                text = text.lstrip()
            if idx == last:
                text = text.rstrip()
            if text:
                st = int(seg_m.group(1))
                segs.append({"t": st, "e": st + max(int(seg_m.group(2)), 0), "x": text})
        if segs:
            rich_lines.append({"t": line_start, "e": max(line_start + line_dur, segs[-1]["e"]), "s": segs})

    if not rich_lines:
        return None, None, None
    rich = _finalize_rich(rich_lines, duration)
    synced, plain = _lines_to_lrc_and_plain(rich_lines)
    return synced, plain, rich


def strip_netease_lrc_credits(lrc_text: str) -> Optional[str]:
    """Keep timed LRC lines from NetEase, stripping Chinese credit headers."""
    kept = []
    for raw in str(lrc_text or "").splitlines():
        stamps = list(_LRC_TIMESTAMP.finditer(raw))
        if not stamps:
            continue
        content = raw[stamps[-1].end():].strip()
        if content and not _NETEASE_CREDIT_RE.match(content):
            kept.append(raw)
    return "\n".join(kept) or None


def parse_lyricsplus(payload: Any) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Parse LyricsPlus JSON into ``(plain_text, rich_synced_or_none)``."""
    if not isinstance(payload, dict) or not isinstance(payload.get("lyrics"), list):
        return None, None

    rich_lines: list[Dict[str, Any]] = []
    for entry in payload["lyrics"]:
        if not isinstance(entry, dict):
            continue
        text = _SPACE_RE.sub(" ", str(entry.get("text") or "")).strip()
        t_ms, dur_ms = entry.get("time"), entry.get("duration")
        if not text or not isinstance(t_ms, (int, float)) or t_ms < 0:
            continue
        start = int(round(t_ms))
        end = start + (int(round(dur_ms)) if isinstance(dur_ms, (int, float)) and dur_ms > 0 else 3000)
        raw_syls = [s for s in (entry.get("syllabus") or []) if isinstance(s, dict) and s.get("text")]
        segs: list[Dict[str, Any]] = []
        last = len(raw_syls) - 1
        for idx, syl in enumerate(raw_syls):
            st, sd, sx = syl.get("time"), syl.get("duration"), str(syl.get("text") or "")
            if not isinstance(st, (int, float)) or st < 0:
                continue
            sx = sx.lstrip() if idx == 0 else sx
            sx = sx.rstrip() if idx == last else sx
            if sx:
                s_start = int(round(st))
                s_end = s_start + (int(round(sd)) if isinstance(sd, (int, float)) and sd > 0 else 0)
                segs.append({"t": s_start, "e": max(s_end, s_start), "x": sx})
        item: Dict[str, Any] = {"t": start, "e": max(end, segs[-1]["e"]) if segs else end, "s": segs or [{"t": start, "e": end, "x": text}]}
        if isinstance(entry.get("element"), dict) and entry["element"].get("isBackground"):
            item["bg"] = True
        rich_lines.append(item)

    if len(rich_lines) < 2:
        return None, None

    meta = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    total_dur: Optional[int] = None
    if meta.get("totalDuration"):
        try:
            ms = _stamp_ms(meta["totalDuration"])
            total_dur = int(round(ms / 1000.0)) if ms and ms > 0 else None
        except ValueError:
            total_dur = None

    rich = _finalize_rich(rich_lines, total_dur)
    _, plain = _lines_to_lrc_and_plain(rich_lines)
    return plain, rich
