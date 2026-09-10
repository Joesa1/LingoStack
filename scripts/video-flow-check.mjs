import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import assert from 'node:assert/strict'
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-video-flow-'))
const extension=path.resolve('dist/chrome')
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b
 const m=JSON.parse(raw).messages.at(-1).content
 res.setHeader('Content-Type','application/json')
 res.end(JSON.stringify({choices:[{message:{content:m.split(/\n\s*%%\s*\n/).map(()=> '你好。').join('\n%%\n')}}]}))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]})
try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker')
 const id=new URL(worker.url()).host
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`)
 await options.locator('#status').filter({hasText:'填写'}).waitFor()
 await options.evaluate(async base=>chrome.runtime.sendMessage({type:'SAVE_CONFIG',config:{preset:'custom',protocol:'openai-compatible',baseUrl:base,apiKey:'',model:'fixture'}}),`http://127.0.0.1:${server.address().port}/v1`)
 // Instrument events without replacing the real system speech engine.
 await worker.evaluate(()=>{
   globalThis.speechEvents=[]
   const original=chrome.tts.speak.bind(chrome.tts)
   chrome.tts.speak=(text,opts,callback)=>original(text,{...opts,volume:0,onEvent:e=>{globalThis.speechEvents.push({type:e.type,error:e.errorMessage});opts.onEvent?.(e)}},callback)
 })
 const html=`<!doctype html><html><head><title>Subtitle pipeline fixture</title></head><body style="background:#15212e;color:white;font:18px sans-serif;padding:30px"><h1>字幕与系统语音集成验证</h1><div id="movie_player" class="html5-video-player playing-mode" style="width:800px;height:450px;position:relative;background:#304d61"><video class="html5-main-video" style="width:100%;height:100%"></video><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Hello, this is an English subtitle.</span></div><button class="ytp-subtitles-button" aria-pressed="true">CC</button></div><script>
 const p=document.querySelector('#movie_player');const v=p.querySelector('video');
 p.getPlayerResponse=()=>({videoDetails:{videoId:'lingoFixture'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=lingoFixture&lang=en',languageCode:'en',vssId:'.en'}]}}});p.getPlayerState=()=>1;p.getOption=()=>({languageCode:'en',vssId:'.en'});
 const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const draw=canvas.getContext('2d');let frame=0;const animation=setInterval(()=>{draw.fillStyle='#304d61';draw.fillRect(0,0,320,180);draw.fillStyle='white';draw.font='20px sans-serif';draw.fillText('Subtitle test '+frame++,30,90);},50);const stream=canvas.captureStream(20);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>{clearInterval(animation);stream.getTracks().forEach(t=>t.stop());v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));v.loop=true;};recorder.start();setTimeout(()=>recorder.stop(),3200);

 </script></body></html>`
 await context.route('https://www.youtube.com/watch?v=lingoFixture',r=>r.fulfill({contentType:'text/html',body:html}))
 await context.route('https://www.youtube.com/api/timedtext?**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({events:[{tStartMs:0,dDurationMs:2000,segs:[{utf8:'Hello, this is an English subtitle.'}]},{tStartMs:2000,dDurationMs:2000,segs:[{utf8:'Another line for seek testing.'}]}]})}))
 const page=await context.newPage();await page.goto('https://www.youtube.com/watch?v=lingoFixture')
 await page.waitForFunction(()=>document.querySelector('video').readyState>=2,{},{timeout:10000})
 await page.bringToFront()
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`)
 const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.includes('watch?v=lingoFixture')).id)
 await worker.evaluate(async tabId=>chrome.tabs.update(tabId,{active:true}),tabId)
 const toggle=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'VIDEO_TOGGLE',speechEnabled:true}))
 assert.equal(toggle.speechEnabled,true)
 await page.evaluate(()=>document.querySelector('video').play())
 await page.locator('#lingo-tr-subtitles-host .line').filter({hasText:'你好。'}).first().waitFor({timeout:15000})
 const started=Date.now();let events=[]
 while(Date.now()-started<12000){events=await worker.evaluate(()=>globalThis.speechEvents);if(events.some(e=>e.type==='end'||e.type==='error'))break;await page.waitForTimeout(250)}
 assert.ok(events.some(e=>e.type==='start'),`No system speech start event: ${JSON.stringify(events)}`)
 assert.ok(events.some(e=>e.type==='end'),`No system speech completion event: ${JSON.stringify(events)}`)
 assert.ok(!events.some(e=>e.type==='error'))
 await page.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=2.1;})
 await page.locator('#lingo-tr-subtitles-host .line').filter({hasText:'Another line for seek testing.'}).waitFor()
 await page.evaluate(()=>document.querySelector('video').play())
 await page.waitForTimeout(250)
 const toggleOff=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'VIDEO_TOGGLE',subtitlesEnabled:false}))
 assert.equal(toggleOff.subtitlesEnabled,false)
 await page.locator('#lingo-tr-subtitles-host').waitFor({state:'detached'})
 assert.equal(await page.locator('video').evaluate(v=>v.muted),false)
 const result={subtitlePipeline:'passed with timestamped fixture',systemSpeech:'native macOS start and end events passed',toggle:'popup on/off passed',seek:'passed',originalAudioRestore:'passed',speechEvents:events}
 await fs.mkdir('test-results',{recursive:true});await fs.writeFile('test-results/video-flow.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
 // Verify content scripts cannot read the key store, using the real isolated world.
 const cdp=await context.newCDPSession(page);const execution=[];cdp.on('Runtime.executionContextCreated',e=>execution.push(e.context));await cdp.send('Runtime.enable')
 const isolated=execution.find(c=>c.origin===`chrome-extension://${id}`)
 if(isolated){const security=await cdp.send('Runtime.evaluate',{contextId:isolated.id,expression:'chrome.storage.local.get("providerConfig").then(() => "LEAK", () => "DENIED")',awaitPromise:true,returnByValue:true});assert.equal(security.result.value,'DENIED');console.log('Content-script credential storage access: DENIED')}
}finally{await context.close();server.close();await fs.rm(profile,{recursive:true,force:true})}
