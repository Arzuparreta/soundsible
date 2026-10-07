package com.soundsible.android;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;

/** Format changes may preserve data; missing or changed copies must still fail acceptance. */
@androidx.media3.common.util.UnstableApi
public class ReleaseUpdateSnapshotTest {
    @Test public void reorderedAndDecoratedStatePreservesCopiesAndPlaylists() throws Exception {
        File file = File.createTempFile("release-copy", ".pcm",
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
        try {
            Files.write(file.toPath(), new byte[]{1, 2, 3});
            var old = new JSONObject("{items:[{track:{id:'a'},state:'ready'},{track:{id:'b'},state:'ready'}],limitBytes:10}");
            var migrated = new JSONObject("{newField:true,items:[{state:'ready',track:{title:'New label',id:'b'}},{track:{id:'a',extra:true},state:'ready'}],limitBytes:20}");
            assertEquals(ReleaseUpdateTest.readyCopies(old, id -> file), ReleaseUpdateTest.readyCopies(migrated, id -> file));
            assertEquals(ReleaseUpdateTest.playlistContents(new JSONObject("{flight:['a','b','a'],other:['b']}")),
                ReleaseUpdateTest.playlistContents(new JSONObject("{other:['b'],flight:['a','b','a']}")));
            assertNotEquals(ReleaseUpdateTest.playlistContents(new JSONObject("{flight:['a','b','a']}")),
                ReleaseUpdateTest.playlistContents(new JSONObject("{flight:['a','a','b']}")));
        } finally { file.delete(); }
    }
    @Test public void lostReadinessAndChangedBytesCannotPreserveCopies() throws Exception {
        File file = File.createTempFile("release-copy", ".pcm",
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
        try {
            var ready = new JSONObject("{items:[{track:{id:'a'},state:'ready'}]}");
            Files.write(file.toPath(), new byte[]{1, 2, 3});
            var saved = ReleaseUpdateTest.readyCopies(ready, id -> file);
            Files.write(file.toPath(), new byte[]{1, 2, 4});
            assertNotEquals(saved, ReleaseUpdateTest.readyCopies(ready, id -> file));
            assertThrows(AssertionError.class, () -> ReleaseUpdateTest.readyCopies(
                new JSONObject("{items:[{track:{id:'a'},state:'queued'}]}"), id -> file));
            assertThrows(AssertionError.class, () -> ReleaseUpdateTest.readyCopies(ready, id -> null));
        } finally { file.delete(); }
    }
}
