package com.soundsible.android

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.*

/** Resolves complete verified local copies at open time. Paths and file URIs stay native. */
@UnstableApi
class OfflineDataSource(private val connection: EngineConnection, private val remote: DataSource.Factory) : DataSource {
    private var delegate: DataSource? = null
    private var epoch = -1L
    private val listeners = mutableListOf<TransferListener>()
    override fun addTransferListener(listener: TransferListener) { listeners.add(listener) }
    override fun open(spec: DataSpec): Long {
        epoch=spec.uri.getQueryParameter("android_generation")?.toLongOrNull() ?: -1
        require(epoch==connection.generation)
        val id=spec.uri.pathSegments.takeIf { it.size==4 && it.take(3)==listOf("api","static","stream") }?.lastOrNull()
        val local=if(id!=null && connection.offline.canUse(epoch)) connection.offline.local(id,epoch) else null
        val source=if(local!=null) FileDataSource() else remote.createDataSource()
        listeners.forEach(source::addTransferListener); delegate=source
        return source.open(if(local!=null) spec.buildUpon().setUri(Uri.fromFile(local)).build() else spec)
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int { require(epoch==connection.generation); return delegate!!.read(buffer,offset,length) }
    override fun getUri(): Uri? = delegate?.uri
    override fun getResponseHeaders(): Map<String,List<String>> = delegate?.responseHeaders ?: emptyMap()
    override fun close() { delegate?.close(); delegate=null }
}
