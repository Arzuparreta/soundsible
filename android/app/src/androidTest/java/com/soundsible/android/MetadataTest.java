package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** Actual text, multipart and cover routes; stable occurrences and durable copy labels. */
@RunWith(AndroidJUnit4.class)
public class MetadataTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText+' '+JSON.stringify(window.__metadata)"));
    }
    private JSONObject library(EngineConnection connection,String origin) throws Exception {
        try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/library").header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){
            assertEquals(200,response.code());return new JSONObject(response.body().string());
        }
    }
    private void command(StartupTest web,ActivityScenario<MainActivity> scenario,String fields) throws Exception {
        web.evaluate(scenario,"window.__done=false;window.__failure=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,"+fields+"})).then(()=>window.__done=true).catch(e=>window.__failure=e.message)");
        waitFor(web,scenario,"window.__done || !!window.__failure");assertEquals(web.evaluate(scenario,"window.__failure"),"true",web.evaluate(scenario,"window.__done"));
    }
    private void edit(StartupTest web,ActivityScenario<MainActivity> scenario,String title) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==="+JSONObject.quote(title)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==="+JSONObject.quote(title)+").closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Edit details')");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Edit details').click()");
        waitFor(web,scenario,"!!document.querySelector('[data-track-metadata-editor]')");
    }
    @Test public void httpMetadata() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsMetadata() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();
        JSONObject original=null;byte[] originalCover=null;
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            var tracks=library(connection,origin).getJSONArray("tracks");for(int i=0;i<tracks.length();i++)if(tracks.getJSONObject(i).getString("id").equals("member-track"))original=tracks.getJSONObject(i);
            assertNotNull(original);
            try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/static/cover/member-track?size=thumb").header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){assertEquals(200,response.code());originalCover=response.body().bytes();}
            web.evaluate(scenario,"window.__metadataTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__metadata=s),100)");
            waitFor(web,scenario,"window.__metadata?.ready");
            command(web,scenario,"action:'queue',tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'},{source:'local',id:'member-track',title:'member private song',artist:'member artist'}],index:0");
            waitFor(web,scenario,"window.__metadata?.playing");command(web,scenario,"action:'pause'");command(web,scenario,"action:'seek',positionMs:20000");
            waitFor(web,scenario,"!window.__metadata.playWhenReady && Math.abs(window.__metadata.positionMs-20000)<1000");
            String keys=web.evaluate(scenario,"JSON.stringify(window.__metadata.items.map(i=>i.key))");String token=web.evaluate(scenario,"window.__metadata.queueToken");
            edit(web,scenario,"member private song");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-track-metadata-editor] input')).filter(i=>i.type!=='file').forEach((i,n)=>{i.value=['Edited private song','Edited artist','Edited album','Edited album artist'][n];i.dispatchEvent(new Event('input',{bubbles:true}))});document.querySelector('[data-track-metadata-editor]').requestSubmit()");
            waitFor(web,scenario,"!document.querySelector('[data-track-metadata-editor]') && window.__metadata?.title==='Edited private song' && window.__metadata.items.every(i=>i.title==='Edited private song' && i.artist==='Edited artist' && i.album==='Edited album')");
            assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__metadata.items.map(i=>i.key))"));assertEquals(token,web.evaluate(scenario,"window.__metadata.queueToken"));assertEquals("true",web.evaluate(scenario,"!window.__metadata.playWhenReady && Math.abs(window.__metadata.positionMs-20000)<1000"));
            web.evaluate(scenario,"window.__copyReady=false;Capacitor.Plugins.SoundsibleOffline.command({action:'prepare',generation:window.__metadata.generation,tracks:[{id:'member-track',title:'Edited private song',artist:'Edited artist',album:'Edited album'}],playlists:{}}).then(()=>window.__copyReady=true)");
            waitFor(web,scenario,"window.__copyReady");web.evaluate(scenario,"window.__copyTimer=setInterval(()=>Capacitor.Plugins.SoundsibleOffline.command({action:'state',generation:window.__metadata.generation}).then(s=>window.__copies=s),100)");
            waitFor(web,scenario,"window.__copies?.items[0]?.state==='ready'");String bytes=web.evaluate(scenario,"window.__copies.items[0].total");
            edit(web,scenario,"Edited private song");
            web.evaluate(scenario,"const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillStyle='#008000';canvas.getContext('2d').fillRect(0,0,16,16);const raw=atob(canvas.toDataURL('image/png').split(',')[1]);const file=new File([Uint8Array.from(raw,c=>c.charCodeAt(0))],'green.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('[data-track-metadata-editor] input[type=file]');Object.defineProperty(input,'files',{value:transfer.files,configurable:true});input.dispatchEvent(new Event('change',{bubbles:true}))");
            waitFor(web,scenario,"!Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).some(b=>b.disabled)");
            assertNull("Multipart cover failed",web.evaluate(scenario,"document.querySelector('[data-track-metadata-editor] [role=alert]')") .equals("null") ? null : "failure");
            try(var loader=new ProgramArtwork(connection)){
                var bitmap=loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(),"member-track",java.util.UUID.randomUUID().toString())).get(10,TimeUnit.SECONDS);
                ArtworkTest.assertColor(0xff008000,bitmap.getPixel(bitmap.getWidth()/2,bitmap.getHeight()/2));
            }
            web.evaluate(scenario,"document.querySelector('[data-track-metadata-editor] input:not([type=file])').value='Offline title';document.querySelector('[data-track-metadata-editor] input:not([type=file])').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-track-metadata-editor]').requestSubmit()");
            waitFor(web,scenario,"!document.querySelector('[data-track-metadata-editor]') && window.__copies.items[0].track.title==='Offline title' && window.__metadata.title==='Offline title'");
            assertEquals(bytes,web.evaluate(scenario,"window.__copies.items[0].total"));assertEquals("true",web.evaluate(scenario,"window.__copies.items[0].state==='ready' && !window.__metadata.playWhenReady && Math.abs(window.__metadata.positionMs-20000)<1000"));
            edit(web,scenario,"Offline title");web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).find(b=>b.textContent==='Remove cover').click()");
            waitFor(web,scenario,"!Array.from(document.querySelectorAll('[data-track-metadata-editor] button')).some(b=>b.disabled)");
            assertEquals("null",web.evaluate(scenario,"document.querySelector('[data-track-metadata-editor] [role=alert]')"));
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        }finally{
            try{
                String cookie=connection.cookieHeader(connection.getGeneration());
                if(cookie!=null && original!=null){
                    var body=new JSONObject();for(String field:new String[]{"title","artist","album","album_artist"})body.put(field,original.opt(field));
                    try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/library/tracks/member-track/metadata").header("Cookie",cookie).post(okhttp3.RequestBody.create(body.toString(),okhttp3.MediaType.get("application/json"))).build()).execute()){assertEquals(200,response.code());}
                    if(originalCover!=null){var upload=new okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).addFormDataPart("file","original.jpg",okhttp3.RequestBody.create(originalCover,okhttp3.MediaType.get("image/jpeg"))).build();try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/library/tracks/member-track/cover").header("Cookie",cookie).post(upload).build()).execute()){assertEquals(200,response.code());}}
                }
            }finally{connection.clearSession(true);}
        }
    }
}
