package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.graphics.Bitmap;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** A real system content grant and physical touch, not a synthetic File or activity result. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@androidx.test.filters.SdkSuppress(minSdkVersion = 29)
@RunWith(AndroidJUnit4.class)
public class CoverPickerTest {
    private final android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void touch(StartupTest web,ActivityScenario<MainActivity> scenario,String selector) throws Exception {
        var point=new JSONObject(web.evaluate(scenario,"(()=>{const element="+selector+";element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,width:window.innerWidth}})()"));
        float[] screen=new float[2];scenario.onActivity(activity->{var view=activity.getBridge().getWebView();int[] location=new int[2];view.getLocationOnScreen(location);double ratio=view.getWidth()/point.optDouble("width");screen[0]=(float)(location[0]+point.optDouble("x")*ratio);screen[1]=(float)(location[1]+point.optDouble("y")*ratio);});
        tap(screen[0],screen[1]);
    }
    private void tap(float x,float y) {
        long now=SystemClock.uptimeMillis();var down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0);var up=MotionEvent.obtain(now,now+80,MotionEvent.ACTION_UP,x,y,0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try{assertTrue(instrumentation.getUiAutomation().injectInputEvent(down,true));assertTrue(instrumentation.getUiAutomation().injectInputEvent(up,true));}finally{down.recycle();up.recycle();}
    }
    private String describe(AccessibilityNodeInfo root,int depth){
        if(root==null||depth>8)return "";String value="\n"+root.getViewIdResourceName()+" | "+root.getText()+" | "+root.getContentDescription();
        for(int i=0;i<Math.min(root.getChildCount(),30);i++)value+=describe(root.getChild(i),depth+1);return value;
    }
    private AccessibilityNodeInfo picker() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(System.nanoTime()<until){var root=instrumentation.getUiAutomation().getRootInActiveWindow();String name=root==null?"":String.valueOf(root.getPackageName());if(name.contains("documentsui")||name.contains("photopicker")||name.contains("providers.media"))return root;Thread.sleep(100);}
        fail("System image picker did not open:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));return null;
    }
    private void awaitApp() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(System.nanoTime()<until){var root=instrumentation.getUiAutomation().getRootInActiveWindow();if(root!=null&&instrumentation.getTargetContext().getPackageName().equals(String.valueOf(root.getPackageName())))return;Thread.sleep(100);}
        fail("Picker did not return to the app:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));
    }
    private boolean colour(int pixel,int expected) {
        // The picker dims and resamples thumbnails. Match the two fixture hues
        // with bounded brightness, then require the four-sided ring geometry.
        int red=(pixel>>16)&255,green=(pixel>>8)&255,blue=pixel&255;
        if(expected==0xff008000)return green>=60&&green<=145&&red<=25&&blue<=25;
        return red>=120&&blue>=120&&green<=30&&Math.abs(red-blue)<=25;
    }
    private void chooseSeededImage() throws Exception {
        // Photo Picker's embedded surface may expose neither filenames nor
        // thumbnail nodes. Identify the fixture by its unique green/pink ring,
        // then physically tap it; never select an arbitrary first photograph.
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        int stableX=-1,stableY=-1;long stableSince=0;
        while(System.nanoTime()<until){
            picker();Bitmap raw=instrumentation.getUiAutomation().takeScreenshot();
            if(raw==null){Thread.sleep(100);continue;}
            Bitmap shot=raw.getConfig()==Bitmap.Config.HARDWARE?raw.copy(Bitmap.Config.ARGB_8888,false):raw;
            try{
                int width=shot.getWidth(),height=shot.getHeight();int[] pixels=new int[width*height];shot.getPixels(pixels,0,width,0,0,width,height);
                int chosenX=-1,chosenY=-1;
                for(int y=20;y<height-20;y+=4)for(int x=20;x<width-20;x+=4){
                    if(!colour(pixels[y*width+x],0xff008000))continue;
                    int left=x,right=x,top=y,bottom=y;
                    while(left>0&&colour(pixels[y*width+left-1],0xff008000))left--;
                    while(right+1<width&&colour(pixels[y*width+right+1],0xff008000))right++;
                    int cx=(left+right)/2;
                    while(top>0&&colour(pixels[(top-1)*width+cx],0xff008000))top--;
                    while(bottom+1<height&&colour(pixels[(bottom+1)*width+cx],0xff008000))bottom++;
                    if(right-left<32||bottom-top<32)continue;
                    int cy=(top+bottom)/2,offset=Math.max(6,(right-left)/12);
                    if(left-offset<0||right+offset>=width||top-offset<0||bottom+offset>=height)continue;
                    if(!colour(pixels[cy*width+left-offset],0xffff00ff)||!colour(pixels[cy*width+right+offset],0xffff00ff)||!colour(pixels[(top-offset)*width+cx],0xffff00ff)||!colour(pixels[(bottom+offset)*width+cx],0xffff00ff))continue;
                    if(chosenX>=0)assertTrue("Fixture visual identity is ambiguous",Math.abs(chosenX-cx)<10&&Math.abs(chosenY-cy)<10);else{chosenX=cx;chosenY=cy;}
                }
                if(chosenX>=0){
                    // The sheet animates after its accessibility root appears.
                    // Wait for a stable target before injecting the physical tap.
                    if(Math.abs(chosenX-stableX)>2||Math.abs(chosenY-stableY)>2){stableX=chosenX;stableY=chosenY;stableSince=SystemClock.uptimeMillis();}
                    else if(SystemClock.uptimeMillis()-stableSince>=400){tap(chosenX,chosenY);return;}
                }else{stableX=-1;stableY=-1;stableSince=0;}
            }finally{if(shot!=raw)shot.recycle();raw.recycle();}
            Thread.sleep(100);
        }
        try(var capture=instrumentation.getUiAutomation().executeShellCommand("screencap -p /data/local/tmp/soundsible-picker.png")){new java.io.FileInputStream(capture.getFileDescriptor()).readAllBytes();}
        fail("Seeded green/pink image is not selectable in the real system picker:"+describe(instrumentation.getUiAutomation().getRootInActiveWindow(),0));
    }
    private byte[] cover(EngineConnection connection,String origin) throws Exception {
        try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/static/cover/member-track?size=thumb").header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){assertEquals(200,response.code());return response.body().bytes();}
    }
    @Test public void httpPicker() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsPicker() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var context=instrumentation.getTargetContext();var connection=EngineConnection.shared(context);connection.clearSession(true);StartupTest web=new StartupTest();Uri imageUri=null;byte[] original=null;
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            original=cover(connection,origin);
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Edit details')");web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Edit details').click()");waitFor(web,scenario,"!!document.querySelector('[data-track-metadata-editor]')");
            String upload="Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).find(b=>b.textContent==='Upload cover')";
            touch(web,scenario,upload);picker();long now=SystemClock.uptimeMillis();assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,now,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BACK,0),true));assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,now+50,KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BACK,0),true));
            awaitApp();waitFor(web,scenario,"!!document.querySelector('[data-track-metadata-editor]') && !Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).some(b=>b.disabled)");assertArrayEquals("Cancelling the OS picker must not write cover",original,cover(connection,origin));
            String filename="soundsible-picker-"+java.util.UUID.randomUUID()+".png";var values=new ContentValues();values.put(MediaStore.Images.Media.DISPLAY_NAME,filename);values.put(MediaStore.Images.Media.MIME_TYPE,"image/png");values.put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/SoundsibleFixture");values.put(MediaStore.Images.Media.DATE_TAKEN,System.currentTimeMillis());
            imageUri=context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);assertNotNull(imageUri);var bitmap=Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xffff00ff);var paint=new android.graphics.Paint();paint.setColor(0xff008000);new android.graphics.Canvas(bitmap).drawRect(4,4,28,28,paint);try(var output=context.getContentResolver().openOutputStream(imageUri)){assertNotNull(output);assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}finally{bitmap.recycle();}
            touch(web,scenario,upload);chooseSeededImage();awaitApp();
            long changedUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);while(java.util.Arrays.equals(original,cover(connection,origin))){assertTrue("Selected image was not uploaded through the OS content grant",System.nanoTime()<changedUntil);Thread.sleep(100);}
            waitFor(web,scenario,"!!document.querySelector('[data-track-metadata-editor]') && !Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).some(b=>b.disabled)");assertEquals("null",web.evaluate(scenario,"document.querySelector('[data-track-metadata-editor] [role=alert]')"));
            try(var loader=new ProgramArtwork(connection)){var bitmapAfter=loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(),"member-track",java.util.UUID.randomUUID().toString())).get(10,TimeUnit.SECONDS);ArtworkTest.assertColor(0xff008000,bitmapAfter.getPixel(bitmapAfter.getWidth()/2,bitmapAfter.getHeight()/2));}
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        }finally{
            try{if(original!=null&&connection.cookieHeader(connection.getGeneration())!=null){var body=new okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).addFormDataPart("file","original.jpg",okhttp3.RequestBody.create(original,okhttp3.MediaType.get("image/jpeg"))).build();try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/library/track-labels/member-track/cover").header("Cookie",connection.cookieHeader(connection.getGeneration())).post(body).build()).execute()){assertEquals(200,response.code());}}}
            finally{if(imageUri!=null)context.getContentResolver().delete(imageUri,null,null);connection.clearSession(true);}
        }
    }
}
