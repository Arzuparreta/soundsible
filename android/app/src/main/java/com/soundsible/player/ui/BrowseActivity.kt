package com.soundsible.player.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.TextView
import com.soundsible.player.R
import com.soundsible.player.SoundsibleApp
import com.soundsible.player.data.CarItem
import com.soundsible.player.net.SoundsibleError
import com.soundsible.player.playback.QueueHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Generic browse list over `/api/car/home` and `/api/car/items/<id>`.
 * One screen for collections and tracks, like the iOS BrowseView.
 */
class BrowseActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val trail: ArrayDeque<Pair<String, String>> = ArrayDeque()
    private val visible: MutableList<CarItem> = mutableListOf()
    private lateinit var adapter: ArrayAdapter<String>
    private lateinit var titleView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_browse)
        titleView = findViewById(R.id.browseTitle)
        val list = findViewById<ListView>(R.id.browseList)
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf())
        list.adapter = adapter
        list.setOnItemClickListener { _, _, position, _ ->
            if (position in visible.indices) open(visible[position])
        }
        findViewById<Button>(R.id.unpairButton).setOnClickListener {
            (application as SoundsibleApp).tokenStore.clear()
            startActivity(Intent(this, PairingActivity::class.java))
            finish()
        }
        load(null)
    }

    override fun onBackPressed() {
        if (trail.isNotEmpty()) {
            trail.removeLast()
            val parent = trail.lastOrNull()
            load(parent)
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun open(item: CarItem) {
        if (item.isBrowsable) {
            trail.addLast(item.id to displayTitle(item))
            load(item.id to displayTitle(item))
        } else if (item.isPlayable) {
            val start = visible.indexOf(item).coerceAtLeast(0)
            QueueHolder.replace(visible, start)
            startActivity(Intent(this, NowPlayingActivity::class.java))
        }
    }

    private fun displayTitle(item: CarItem): String =
        item.title.ifEmpty { item.id }

    private fun load(node: Pair<String, String>?) {
        val app = application as SoundsibleApp
        titleView.text = node?.second ?: getString(R.string.browse_title)
        scope.launch {
            try {
                val response = withContext(Dispatchers.IO) {
                    if (node == null) app.client.home() else app.client.items(node.first)
                }
                visible.clear()
                visible.addAll(response.items)
                adapter.clear()
                adapter.addAll(response.items.map { rowLabel(it) })
            } catch (e: Exception) {
                visible.clear()
                adapter.clear()
                adapter.add(messageOf(e))
            }
        }
    }

    private fun rowLabel(item: CarItem): String {
        val suffix = when {
            item.isBrowsable -> " ›"
            item.subtitle.isNotEmpty() -> " — ${item.subtitle}"
            item.artist.isNotEmpty() -> " — ${item.artist}"
            else -> ""
        }
        return item.title + suffix
    }

    private fun messageOf(e: Exception): String = when (e) {
        is SoundsibleError -> e.message ?: "Browse failed."
        else -> "Could not reach your Soundsible."
    }
}
