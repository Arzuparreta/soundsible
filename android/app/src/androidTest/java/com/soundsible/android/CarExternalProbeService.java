package com.soundsible.android;

import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.media.browse.MediaBrowser;
import android.os.*;

/** Platform APIs only: this independent APK process cannot load the target's dependencies. */
public class CarExternalProbeService extends Service {
    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaBrowser browser;
    private void finish(Messenger reply, Bundle response) {
        try { Message answer = Message.obtain(); answer.setData(response); reply.send(answer); } catch (RemoteException ignored) {}
        if (browser != null) browser.disconnect();
        browser = null;
    }
    private final Messenger incoming = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override public void handleMessage(Message message) {
            final Messenger reply = message.replyTo;
            if (reply == null) return;
            if (browser != null) browser.disconnect();
            final Bundle response = new Bundle();
            response.putInt("uid", android.os.Process.myUid());
            String target = message.getData().getString("target");
            if (target == null) return;
            browser = new MediaBrowser(CarExternalProbeService.this,
                new ComponentName(target, "com.soundsible.android.PlaybackService"), new MediaBrowser.ConnectionCallback() {
                    @Override public void onConnectionFailed() { response.putBoolean("connected", false); finish(reply, response); }
                    @Override public void onConnected() {
                        response.putBoolean("connected", true);
                        browser.subscribe("all-tracks", new MediaBrowser.SubscriptionCallback() {
                            @Override public void onError(String parent) { response.putString("error", "browse"); finish(reply, response); }
                            @Override public void onChildrenLoaded(String parent, java.util.List<MediaBrowser.MediaItem> children) {
                                MediaBrowser.MediaItem song = null;
                                for (var row : children) if ("soundsible:track:member-track".equals(row.getMediaId())) { song = row; break; }
                                if (song == null) { response.putString("error", "missing_song"); finish(reply, response); return; }
                                final android.net.Uri uri = song.getDescription().getIconUri();
                                response.putString("uri", uri == null ? null : uri.toString());
                                new Thread(() -> {
                                    try {
                                        android.graphics.Bitmap image;
                                        try (var input = getContentResolver().openInputStream(uri)) { image = android.graphics.BitmapFactory.decodeStream(input); }
                                        response.putBoolean("artwork", image != null);
                                        if (image != null) image.recycle();
                                        try (var file = getContentResolver().openFileDescriptor(uri, "w")) { response.putBoolean("writeDenied", false); }
                                        catch (Exception denied) { response.putBoolean("writeDenied", true); }
                                    } catch (Exception error) { response.putString("error", error.getClass().getSimpleName()); }
                                    main.post(() -> finish(reply, response));
                                }).start();
                            }
                        });
                    }
                }, null);
            browser.connect();
        }
    });
    @Override public IBinder onBind(Intent intent) { return incoming.getBinder(); }
    @Override public void onDestroy() { if (browser != null) browser.disconnect(); super.onDestroy(); }
}
