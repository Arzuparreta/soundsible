package com.soundsible.android

/** Delete acquired source references, preserving previews and every surviving occurrence. */
object SourceRetirement {
    data class Reference(val id: String, val source: String)
    fun ranges(items: List<Reference>, id: String): List<IntRange> {
        require(id.isNotBlank() && id.length <= 512)
        val ranges = mutableListOf<IntRange>()
        var start = -1
        for (index in 0..items.size) {
            val matches = index < items.size && items[index].source == "local" && items[index].id == id
            if (matches && start < 0) start = index
            if (!matches && start >= 0) { ranges.add(start until index); start = -1 }
        }
        return ranges.asReversed()
    }
}
