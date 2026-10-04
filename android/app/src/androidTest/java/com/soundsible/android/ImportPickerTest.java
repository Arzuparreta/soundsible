package com.soundsible.android;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.graphics.Rect;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;
@androidx.test.filters.SdkSuppress(minSdkVersion = 29)
@RunWith(AndroidJUnit4.class)
public class ImportPickerTest {
    private final android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void touch(StartupTest web,ActivityScenario<MainActivity> scenario,String selector) throws Exception {
        var point=new JSONObject(web.evaluate(scenario,"(()=>{const element="+selector+";element.scrollIntoView({block:'center',behavior:'instant'});const box=element.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,width:window.innerWidth}})()"));
        float[] screen=new float[2];scenario.onActivity(activity->{var view=activity.getBridge().getWebView();int[] location=new int[2];view.getLocationOnScreen(location);double ratio=view.getWidth()/point.optDouble("width");screen[0]=(float)(location[0]+point.optDouble("x")*ratio);screen[1]=(float)(location[1]+point.optDouble("y")*ratio);});
        Thread.sleep(250);
        var settled=new JSONObject(web.evaluate(scenario,"(()=>{const element="+selector+";const box=element.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,width:window.innerWidth,hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('button')===element}})()"));
        assertTrue("Target is outside the viewport or covered: "+settled,settled.getBoolean("hit"));
        scenario.onActivity(activity->{var view=activity.getBridge().getWebView();int[] location=new int[2];view.getLocationOnScreen(location);double ratio=view.getWidth()/settled.optDouble("width");screen[0]=(float)(location[0]+settled.optDouble("x")*ratio);screen[1]=(float)(location[1]+settled.optDouble("y")*ratio);});
        tap(screen[0],screen[1]);
    }
    private void tap(float x,float y) {
        long now=SystemClock.uptimeMillis();
        var properties=new MotionEvent.PointerProperties();properties.id=0;properties.toolType=MotionEvent.TOOL_TYPE_FINGER;
        var coords=new MotionEvent.PointerCoords();coords.x=x;coords.y=y;coords.pressure=1;coords.size=1;
        var pointers=new MotionEvent.PointerProperties[]{properties};var coordinates=new MotionEvent.PointerCoords[]{coords};
        var down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,1,pointers,coordinates,0,0,1,1,0,0,InputDevice.SOURCE_TOUCHSCREEN,0);
        try{assertTrue(instrumentation.getUiAutomation().injectInputEvent(down,true));}finally{down.recycle();}
        SystemClock.sleep(80);coords.pressure=0;
        var up=MotionEvent.obtain(now,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,1,pointers,coordinates,0,0,1,1,0,0,InputDevice.SOURCE_TOUCHSCREEN,0);
        try{assertTrue(instrumentation.getUiAutomation().injectInputEvent(up,true));}finally{up.recycle();}
    }
    private String describe(AccessibilityNodeInfo root,int depth){
        if(root==null||depth>16)return "";String value="\n"+root.getViewIdResourceName()+" | "+root.getText()+" | "+root.getContentDescription();
        for(int i=0;i<Math.min(root.getChildCount(),30);i++)value+=describe(root.getChild(i),depth+1);return value;
    }
    private AccessibilityNodeInfo picker() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);long stableSince=0;
        while(System.nanoTime()<until){var root=instrumentation.getUiAutomation().getRootInActiveWindow();String name=root==null?"":String.valueOf(root.getPackageName());
            if(name.contains("documentsui")){if(stableSince==0)stableSince=SystemClock.uptimeMillis();if(SystemClock.uptimeMillis()-stableSince>=600)return root;}else stableSince=0;
            Thread.sleep(100);
        }
        fail("System document picker did not open:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));return null;
    }
    private void cancelPicker() throws Exception {
        for(int attempt=0;attempt<4;attempt++){
            var root=instrumentation.getUiAutomation().getRootInActiveWindow();
            if(root!=null&&instrumentation.getTargetContext().getPackageName().equals(String.valueOf(root.getPackageName())))return;
            long now=SystemClock.uptimeMillis();
            assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,now,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BACK,0,0,android.view.KeyCharacterMap.VIRTUAL_KEYBOARD,0,KeyEvent.FLAG_FROM_SYSTEM,InputDevice.SOURCE_KEYBOARD),true));
            Thread.sleep(80);
            assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,SystemClock.uptimeMillis(),KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BACK,0,0,android.view.KeyCharacterMap.VIRTUAL_KEYBOARD,0,KeyEvent.FLAG_FROM_SYSTEM,InputDevice.SOURCE_KEYBOARD),true));
            Thread.sleep(800);
        }
        awaitApp();
    }
    private void awaitApp() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(System.nanoTime()<until){var root=instrumentation.getUiAutomation().getRootInActiveWindow();if(root!=null&&instrumentation.getTargetContext().getPackageName().equals(String.valueOf(root.getPackageName())))return;Thread.sleep(100);}
        try{instrumentation.getUiAutomation().executeShellCommand("screencap -p /data/local/tmp/soundsible-import.png").close();SystemClock.sleep(300);}catch(Exception ignored){}
        fail("Picker did not return to the app:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));
    }
    private JSONObject api(EngineConnection connection,String origin,String path) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path).header("Cookie",connection.cookieHeader(connection.getGeneration())).build();
        try(var response=connection.getClient().newCall(request).execute()){assertEquals(200,response.code());return new JSONObject(response.body().string());}
    }
    private void action(StartupTest web,ActivityScenario<MainActivity> scenario,String name) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(name)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(name)+").click()");
    }
    private AccessibilityNodeInfo navigation(AccessibilityNodeInfo root) {
        if(root==null)return null;String description=String.valueOf(root.getContentDescription());
        if(description.equals("Show roots")||description.equals("Show navigation drawer"))return root;
        for(int i=0;i<root.getChildCount();i++){var found=navigation(root.getChild(i));if(found!=null)return found;}return null;
    }
    private void tapNode(AccessibilityNodeInfo node){var bounds=new Rect();node.getBoundsInScreen(bounds);assertFalse(bounds.isEmpty());tap(bounds.centerX(),bounds.centerY());}
    private void selectFile(String name) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(25);boolean openedRoots=false;boolean downloads=false;
        while(System.nanoTime()<until){
            var root=picker();var nodes=root.findAccessibilityNodeInfosByText(name);
            for(var node:nodes)if(name.equals(String.valueOf(node.getText()))){var bounds=new Rect();node.getBoundsInScreen(bounds);if(!bounds.isEmpty()&&node.isVisibleToUser()){android.util.Log.i("ImportTouch","Own export bounds="+bounds+" enabled="+node.isEnabled());tap(bounds.centerX(),bounds.centerY());return;}}
            if(!openedRoots){var button=navigation(root);if(button!=null){tapNode(button);openedRoots=true;Thread.sleep(600);continue;}}
            if(openedRoots&&!downloads){for(var node:root.findAccessibilityNodeInfosByText("Downloads"))if("Downloads".equals(String.valueOf(node.getText()))){tapNode(node);downloads=true;Thread.sleep(600);break;}}
            Thread.sleep(100);
        }
        try{instrumentation.getUiAutomation().executeShellCommand("screencap -p /data/local/tmp/soundsible-import.png").close();}catch(Exception ignored){}
        fail("Own export missing from DocumentsUI:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));
    }
    @Test public void httpImport() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsImport() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var context=instrumentation.getTargetContext();var resolver=context.getContentResolver();var connection=EngineConnection.shared(context);connection.clearSession(true);
        String name="soundsible-import-"+java.util.UUID.randomUUID()+".csv";var values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,name);values.put(MediaStore.Downloads.MIME_TYPE,"text/csv");values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS);
        Uri uri=resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values);assertNotNull(uri);
        try(var stream=resolver.openOutputStream(uri)){stream.write("Name,Artist,Album,Duration\nmember private song,member artist,member album,600\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en');localStorage.removeItem('soundsible.migration-guide')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            int before=api(connection,origin,"/api/migration/jobs").getJSONArray("jobs").length();
            web.evaluate(scenario,"document.querySelector('[data-android-migrate]').click()");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button strong')).find(b=>b.textContent==='Spotify')");touch(web,scenario,"Array.from(document.querySelectorAll('button strong')).find(b=>b.textContent==='Spotify').closest('button')");
            touch(web,scenario,"document.querySelector('[data-native-import-select]')");
            try{picker();}catch(AssertionError error){fail(error.getMessage()+": "+web.evaluate(scenario,"document.body.innerText"));}cancelPicker();awaitApp();
            waitFor(web,scenario,"!!document.querySelector('[data-native-import-select]:not(:disabled)')");assertEquals(before,api(connection,origin,"/api/migration/jobs").getJSONArray("jobs").length());
            touch(web,scenario,"document.querySelector('[data-native-import-select]')");selectFile(name);awaitApp();
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Start import')");
            var jobs=api(connection,origin,"/api/migration/jobs").getJSONArray("jobs");assertEquals(before+1,jobs.length());String id=jobs.getJSONObject(0).getString("id");
            var detail=api(connection,origin,"/api/migration/jobs/"+id).getJSONObject("job");assertEquals(1,detail.getJSONObject("manifest").getInt("track_count"));assertEquals("member-track",detail.getJSONArray("tracks").getJSONObject(0).getString("matched_track_id"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Library').click();document.querySelector('[data-android-migrate]').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Start import')");
            assertEquals(before+1,api(connection,origin,"/api/migration/jobs").getJSONArray("jobs").length());
            action(web,scenario,"Start import");
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);String state="";while(!state.equals("completed")){state=api(connection,origin,"/api/migration/jobs/"+id).getJSONObject("job").getString("state");assertTrue("Import stalled: "+state,System.nanoTime()<until);Thread.sleep(100);}
            detail=api(connection,origin,"/api/migration/jobs/"+id).getJSONObject("job");String playlist=detail.getJSONObject("playlist_names").getString("playlist-0");
            var ids=api(connection,origin,"/api/library").getJSONObject("playlists").getJSONArray(playlist);assertEquals(1,ids.length());assertEquals("member-track",ids.getString(0));
            action(web,scenario,"Open library");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]') && !!Array.from(document.querySelectorAll('[data-testid=android-library] button')).find(b=>b.textContent==='Playlists' && b.getAttribute('aria-pressed')==='true')");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        }finally{resolver.delete(uri,null,null);connection.clearSession(true);}
    }
}
