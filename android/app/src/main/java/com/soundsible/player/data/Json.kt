package com.soundsible.player.data

/**
 * Minimal JSON value model + parser for the engine contract.
 *
 * `org.json` ships with Android but is a stub on JVM unit tests, and pulling
 * a JSON framework for a handful of known shapes would break the kit's
 * dependency-free, Linux-testable split (see ios/SoundsibleKit). This covers
 * exactly what the engine sends: objects, arrays, strings, numbers, booleans
 * and null.
 */
class JsonObject(val map: Map<String, Any?> = emptyMap()) {
    fun has(key: String): Boolean = map.containsKey(key)
    fun isNull(key: String): Boolean = !map.containsKey(key) || map[key] == null
    fun optString(key: String, fallback: String = ""): String = (map[key] as? String) ?: fallback
    fun optInt(key: String): Int? = (map[key] as? Number)?.toInt()
    fun optLong(key: String): Long? = (map[key] as? Number)?.toLong()
    fun optDouble(key: String): Double? = (map[key] as? Number)?.toDouble()
    fun optBoolean(key: String, fallback: Boolean = false): Boolean = (map[key] as? Boolean) ?: fallback
    fun optObject(key: String): JsonObject? = map[key] as? JsonObject
    fun optArray(key: String): JsonArray? = map[key] as? JsonArray

    fun toJsonString(): String = buildString {
        append('{')
        map.entries.forEachIndexed { i, (k, v) ->
            if (i > 0) append(',')
            append('"').append(escape(k)).append('"').append(':')
            appendValue(v)
        }
        append('}')
    }

    companion object {
        fun builder(): Builder = Builder()
    }

    class Builder {
        private val map = LinkedHashMap<String, Any?>()
        fun put(key: String, value: Any?): Builder = apply { map[key] = value }
        fun build(): JsonObject = JsonObject(map.toMap())
    }
}

class JsonArray(val items: List<Any?> = emptyList()) {
    val length: Int get() = items.size
    fun getObject(i: Int): JsonObject = items[i] as JsonObject
    fun optObject(i: Int): JsonObject? = items.getOrNull(i) as? JsonObject
}

internal fun StringBuilder.appendValue(v: Any?) {
    when (v) {
        null -> append("null")
        is String -> append('"').append(escape(v)).append('"')
        is Number, is Boolean -> append(v.toString())
        is JsonObject -> append(v.toJsonString())
        is JsonArray -> {
            append('[')
            v.items.forEachIndexed { i, item ->
                if (i > 0) append(',')
                appendValue(item)
            }
            append(']')
        }
        else -> append('"').append(escape(v.toString())).append('"')
    }
}

internal fun escape(s: String): String = buildString {
    for (c in s) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
}

class JsonParseException(message: String) : Exception(message)

/** Parse one JSON object. Throws [JsonParseException] on malformed input. */
fun parseJsonObject(text: String): JsonObject {
    val parser = Parser(text)
    val value = parser.parseValue()
    parser.skipWs()
    if (!parser.atEnd()) throw JsonParseException("Trailing content after JSON object")
    return value as? JsonObject ?: throw JsonParseException("Top level is not an object")
}

private class Parser(val text: String) {
    var pos = 0

    fun atEnd(): Boolean = pos >= text.length

    fun skipWs() {
        while (pos < text.length && text[pos].isWhitespace()) pos++
    }

    fun parseValue(): Any? {
        skipWs()
        if (pos >= text.length) throw JsonParseException("Unexpected end of input")
        return when (val c = text[pos]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> parseString()
            't' -> expect("true", true)
            'f' -> expect("false", false)
            'n' -> expect("null", null)
            '-', in '0'..'9' -> parseNumber()
            else -> throw JsonParseException("Unexpected character '$c' at $pos")
        }
    }

    private fun expect(literal: String, value: Any?): Any? {
        if (!text.startsWith(literal, pos)) throw JsonParseException("Expected $literal at $pos")
        pos += literal.length
        return value
    }

    private fun parseObject(): JsonObject {
        pos++ // {
        val map = LinkedHashMap<String, Any?>()
        skipWs()
        if (pos < text.length && text[pos] == '}') {
            pos++
            return JsonObject(map)
        }
        while (true) {
            skipWs()
            if (pos >= text.length || text[pos] != '"') throw JsonParseException("Expected string key at $pos")
            val key = parseString()
            skipWs()
            if (pos >= text.length || text[pos] != ':') throw JsonParseException("Expected ':' at $pos")
            pos++
            map[key] = parseValue()
            skipWs()
            if (pos >= text.length) throw JsonParseException("Unterminated object")
            when (text[pos]) {
                ',' -> pos++
                '}' -> {
                    pos++
                    return JsonObject(map)
                }
                else -> throw JsonParseException("Expected ',' or '}' at $pos")
            }
        }
    }

    private fun parseArray(): JsonArray {
        pos++ // [
        val items = mutableListOf<Any?>()
        skipWs()
        if (pos < text.length && text[pos] == ']') {
            pos++
            return JsonArray(items)
        }
        while (true) {
            items.add(parseValue())
            skipWs()
            if (pos >= text.length) throw JsonParseException("Unterminated array")
            when (text[pos]) {
                ',' -> pos++
                ']' -> {
                    pos++
                    return JsonArray(items)
                }
                else -> throw JsonParseException("Expected ',' or ']' at $pos")
            }
        }
    }

    private fun parseString(): String {
        pos++ // opening quote
        val out = StringBuilder()
        while (pos < text.length) {
            val c = text[pos++]
            when (c) {
                '"' -> return out.toString()
                '\\' -> {
                    if (pos >= text.length) throw JsonParseException("Unterminated escape")
                    when (val e = text[pos++]) {
                        '"', '\\', '/' -> out.append(e)
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (pos + 4 > text.length) throw JsonParseException("Bad unicode escape")
                            val hex = text.substring(pos, pos + 4)
                            out.append(hex.toInt(16).toChar())
                            pos += 4
                        }
                        else -> throw JsonParseException("Bad escape '\\$e'")
                    }
                }
                else -> out.append(c)
            }
        }
        throw JsonParseException("Unterminated string")
    }

    private fun parseNumber(): Number {
        val start = pos
        if (pos < text.length && text[pos] == '-') pos++
        while (pos < text.length && text[pos].isDigit()) pos++
        var isDouble = false
        if (pos < text.length && text[pos] == '.') {
            isDouble = true
            pos++
            while (pos < text.length && text[pos].isDigit()) pos++
        }
        if (pos < text.length && (text[pos] == 'e' || text[pos] == 'E')) {
            isDouble = true
            pos++
            if (pos < text.length && (text[pos] == '+' || text[pos] == '-')) pos++
            while (pos < text.length && text[pos].isDigit()) pos++
        }
        val raw = text.substring(start, pos)
        return try {
            if (isDouble) raw.toDouble() else raw.toLong()
        } catch (_: NumberFormatException) {
            throw JsonParseException("Bad number '$raw'")
        }
    }
}
