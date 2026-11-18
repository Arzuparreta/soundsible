"""The DJ API contract: validate engine responses and generate the web client's types.

`shared/contracts/api/dj.schema.json` is the one description of what the
generated-queue and DJ endpoints answer. This module reads the subset of JSON
Schema that file uses (type, enum, const, properties, required,
additionalProperties, items, prefixItems, minItems, maxItems, anyOf, $ref) plus
two keywords of its own: `$extends`, which copies another definition's
properties and required names, and `partial`, which waives a reference's
required names.

    python scripts/api_contract.py --write   # regenerate the TypeScript types
    python scripts/api_contract.py --check   # fail when they are out of date
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "shared/contracts/api/dj.schema.json"
GENERATED = ROOT / "ui_web/src/lib/generated/djContract.ts"

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def load(path: Path = SCHEMA) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class ContractError(ValueError):
    pass


def _resolve(root: dict, ref: str) -> dict:
    if not ref.startswith("#/$defs/"):
        raise ContractError(f"unsupported reference {ref}")
    return root["$defs"][ref[len("#/$defs/"):]]


def expand(root: dict, schema: dict) -> dict:
    """`schema` with its `$extends` chain merged in."""
    if "$extends" not in schema:
        return schema
    parent = expand(root, _resolve(root, schema["$extends"]))
    merged = {**parent, **{k: v for k, v in schema.items() if k != "$extends"}}
    merged["properties"] = {**parent.get("properties", {}), **schema.get("properties", {})}
    merged["required"] = [*parent.get("required", []), *[n for n in schema.get("required", []) if n not in parent.get("required", [])]]
    return merged


def validate(instance, schema: dict, root: dict, path: str = "$", *, partial: bool = False) -> None:
    """Raise ContractError naming the first place `instance` breaks `schema`."""
    if "$ref" in schema:
        target = expand(root, _resolve(root, schema["$ref"]))
        validate(instance, target, root, path, partial=partial or bool(schema.get("partial")))
        return
    schema = expand(root, schema)
    if "anyOf" in schema:
        errors = []
        for option in schema["anyOf"]:
            try:
                validate(instance, option, root, path)
                break
            except ContractError as error:
                errors.append(str(error))
        else:
            raise ContractError(f"{path}: matches no option ({'; '.join(errors)})")
    if "const" in schema and instance != schema["const"]:
        raise ContractError(f"{path}: expected {schema['const']!r}, got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        raise ContractError(f"{path}: {instance!r} is not one of {schema['enum']!r}")
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_TYPES[kind](instance) for kind in kinds):
            raise ContractError(f"{path}: expected {'/'.join(kinds)}, got {type(instance).__name__}")
    if isinstance(instance, dict) and ("properties" in schema or "additionalProperties" in schema):
        properties = schema.get("properties", {})
        if not partial:
            for name in schema.get("required", []):
                if name not in instance:
                    raise ContractError(f"{path}: missing {name!r}")
        extra = schema.get("additionalProperties", True)
        for name, value in instance.items():
            if name in properties:
                validate(value, properties[name], root, f"{path}.{name}")
            elif extra is False:
                raise ContractError(f"{path}: unexpected {name!r}")
            elif isinstance(extra, dict):
                validate(value, extra, root, f"{path}.{name}")
    if isinstance(instance, list):
        if len(instance) < schema.get("minItems", 0) or len(instance) > schema.get("maxItems", len(instance)):
            raise ContractError(f"{path}: {len(instance)} items")
        for index, value in enumerate(instance):
            if index < len(schema.get("prefixItems", [])):
                validate(value, schema["prefixItems"][index], root, f"{path}[{index}]")
            elif "items" in schema:
                validate(value, schema["items"], root, f"{path}[{index}]")


def validate_response(definition: str, body, root: dict | None = None) -> None:
    root = root or load()
    validate(body, {"$ref": f"#/$defs/{definition}"}, root, definition)


# --- TypeScript ---------------------------------------------------------------


def _literal(value) -> str:
    return "null" if value is None else json.dumps(value)


def _ts(schema: dict, root: dict, indent: str) -> str:
    if "$ref" in schema:
        name = schema["$ref"][len("#/$defs/"):]
        return f"Partial<{name}>" if schema.get("partial") else name
    if "anyOf" in schema:
        return " | ".join(_ts(option, root, indent) for option in schema["anyOf"])
    if "const" in schema:
        return _literal(schema["const"])
    if "enum" in schema:
        return " | ".join(_literal(value) for value in schema["enum"])
    kinds = schema.get("type", [])
    kinds = kinds if isinstance(kinds, list) else [kinds]
    parts = []
    for kind in kinds:
        if kind in ("string", "boolean", "null"):
            parts.append(kind)
        elif kind in ("number", "integer"):
            parts.append("number")
        elif kind == "array":
            if "prefixItems" in schema:
                parts.append("[" + ", ".join(_ts(item, root, indent) for item in schema["prefixItems"]) + "]")
            else:
                item = _ts(schema.get("items", {}), root, indent)
                parts.append(f"({item})[]" if " | " in item else f"{item}[]")
        elif kind == "object":
            parts.append(_object(schema, root, indent))
    return " | ".join(dict.fromkeys(parts)) or "unknown"


def _comment(text: str | None, indent: str) -> str:
    if not text:
        return ""
    lines = text.split("\n")
    if len(lines) == 1:
        return f"{indent}/** {lines[0]} */\n"
    body = "".join(f"{indent} * {line}".rstrip() + "\n" for line in lines)
    return f"{indent}/**\n{body}{indent} */\n"


def _members(schema: dict, root: dict, indent: str, own_only: dict | None = None) -> str:
    required = set(schema.get("required", []))
    properties = own_only if own_only is not None else schema.get("properties", {})
    out = []
    for name, prop in properties.items():
        optional = "" if name in required else "?"
        out.append(_comment(prop.get("description"), indent) + f"{indent}{name}{optional}: {_ts(prop, root, indent)};\n")
    return "".join(out)


def _object(schema: dict, root: dict, indent: str) -> str:
    extra = schema.get("additionalProperties")
    if not schema.get("properties") and isinstance(extra, dict):
        return f"Record<string, {_ts(extra, root, indent)} | undefined>"
    return "{\n" + _members(schema, root, indent + "  ") + indent + "}"


def typescript(root: dict | None = None) -> str:
    root = root or load()
    out = [
        "// Generated by scripts/api_contract.py from shared/contracts/api/dj.schema.json.\n",
        "// Do not edit: change the schema and run `python scripts/api_contract.py --write`.\n",
    ]
    for name, schema in root["$defs"].items():
        out.append("\n" + _comment(schema.get("description"), ""))
        if "$extends" in schema:
            parent = schema["$extends"][len("#/$defs/"):]
            body = _members(expand(root, schema), root, "  ", schema.get("properties", {}))
            out.append(f"export interface {name} extends {parent} {{\n{body}}}\n")
        elif schema.get("type") == "object":
            out.append(f"export interface {name} {{\n{_members(schema, root, '  ')}}}\n")
        else:
            out.append(f"export type {name} = {_ts(schema, root, '')};\n")
    return "".join(out)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    text = typescript()
    if args.write:
        GENERATED.parent.mkdir(parents=True, exist_ok=True)
        GENERATED.write_text(text, encoding="utf-8")
        return 0
    if not GENERATED.exists() or GENERATED.read_text(encoding="utf-8") != text:
        print(f"{GENERATED.relative_to(ROOT)} is out of date: run python scripts/api_contract.py --write", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
