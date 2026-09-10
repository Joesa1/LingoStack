import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-youtube-'))
const ext=path.resolve('dist/chrome')
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:false,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]})
try {
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker')
 const id=new URL(worker.url()).host
 let requests=0
 const http=await import('node:http')
 const server=http.createServer(async(req,res)=>{requests++;let text='';for await(const b of req)text+=b;const data=JSON.parse(text);const n=data.messages.at(-1).content.split(/\n\s*%%\s*\n/).length;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:Array.from({length:n},()=> '这是一条用于验证字幕朗读的中文测试译文。').join('\n%%\n')}}]}))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`)
 await options.locator('#status').filter({hasText:'填写'}).waitFor()
 await options.evaluate(async base=>chrome.runtime.sendMessage({type:'SAVE_CONFIG',config:{preset:'custom',protocol:'openai-compatible',baseUrl:base,model:'fixture',apiKey:''}}),`http://127.0.0.1:${server.address().port}/v1`)
 const page=await context.newPage()
 page.on('response',async r=>{if(r.url().includes('/api/timedtext')){try{const text=await r.text();console.log('Caption response:',JSON.stringify({status:r.status(),length:text.length,format:new URL(r.url()).searchParams.get('fmt'),lang:new URL(r.url()).searchParams.get('lang'),preview:text.slice(0,90)}))}catch{}}})
 page.on('pageerror',e=>console.log('Page error:',e.message.slice(0,180)))
 await page.goto('https://www.youtube.com/watch?v=arj7oStGLkU',{waitUntil:'domcontentloaded',timeout:30000})
 await page.waitForTimeout(3000)
 console.log('Player track metadata:', await page.evaluate(()=>{const p=document.querySelector('#movie_player');return {selectedLanguage:p.getOption?.('captions','track')?.languageCode, tracks:p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.map(t=>({lang:t.languageCode, keys:[...new URL(t.baseUrl).searchParams.keys()]}))}}))
 await page.evaluate(()=>{const p=document.querySelector('#movie_player');p.loadModule?.('captions');p.setOption?.('captions','track',{languageCode:'en'});})
 const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.includes('watch?v=')).id)
 await worker.evaluate(async tabId=>{await chrome.storage.session.set({videoTabs:{[tabId]:{subtitlesEnabled:true,speechEnabled:true}}});await chrome.tabs.sendMessage(tabId,{type:'LINGO_VIDEO_SETTINGS',subtitlesEnabled:true,speechEnabled:true},{frameId:0})},tabId)
 await page.locator('#movie_player video').evaluate(v=>{v.muted=true; v.loop=true; return v.play()})
 await page.waitForTimeout(20000)
 const snapshot=await page.evaluate(()=>({title:document.title,currentTime:document.querySelector('video').currentTime,paused:document.querySelector('video').paused,cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),overlay:[...(document.querySelector('#lingo-tr-subtitles-host')?.shadowRoot?.querySelectorAll('.line,.pill')??[])].map(e=>({text:e.textContent,hidden:e.hidden})),native:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent)}))
 console.log('Result:',JSON.stringify({...snapshot,requests}))
 await fs.mkdir('test-results',{recursive:true});await fs.writeFile('test-results/youtube-integration.json',JSON.stringify({...snapshot,requests},null,2));await page.screenshot({path:'test-results/youtube-integration.png'})
 await context.close();server.close()
}finally{await context.close();await fs.rm(profile,{recursive:true,force:true})}
