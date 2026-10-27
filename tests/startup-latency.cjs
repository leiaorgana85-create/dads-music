const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const root=path.resolve(__dirname,'..');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
function worker(){
 const handlers={},entries=new Map(),removed=[],installed=[];let calls=0,network=async()=>new Response('network');
 const scope='https://example.test/player/';
 const cache={match:async(input,options={})=>{let key=new URL(typeof input==='string'?input:input.url,scope);if(options.ignoreSearch)key.search='';for(const [name,response]of entries){const candidate=new URL(name,scope);if(options.ignoreSearch)candidate.search='';if(candidate.href===key.href)return response.clone()}},put:async()=>{},addAll:async requests=>installed.push(...requests)};
 const c={URL,Request,Response,Promise,console,self:{location:{href:scope+'sw.js'},registration:{scope},addEventListener:(type,fn)=>handlers[type]=fn,skipWaiting(){},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>['OLD_CACHE','OTHER_APP'],delete:async key=>removed.push(key)},fetch:(...args)=>{calls++;return network(...args)}};
 const script=source('sw.js');const cacheName=script.match(/const (?:CACHE_NAME|CACHE)\s*=\s*'([^']+)'/)[1];
 c.caches.keys=async()=>[cacheName.replace(/\d+$/,'0'),'unrelated-shell'];vm.runInNewContext(script,c);
 const request=(file,options={})=>{let promise;handlers.fetch({request:{url:new URL(file,scope).href,method:'GET',mode:'cors',...options},respondWith:p=>promise=p,waitUntil:p=>p.catch(()=>{})});return promise};
 return {handlers,entries,removed,installed,request,setNetwork:fn=>network=fn,calls:()=>calls};
}
function element(){return {hidden:true,value:'',textContent:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},append(){},replaceChildren(){},addEventListener(){},setAttribute(){},removeAttribute(){},querySelector(){return null},focus(){},setSelectionRange(){}}}
async function startup(){
 const els=new Map();let audioReady=false;const storage={get ready(){audioReady=true;return new Promise(()=>{})}};
 const c={URL,URLSearchParams,Blob,ArrayBuffer,Set,Map,JSON,Promise,Date,Math,console,Intl,localStorage:store(),sessionStorage:store(),navigator:{onLine:false,serviceWorker:{register:()=>new Promise(()=>{})}},setTimeout(){},clearTimeout(){},setInterval(){},addEventListener(){},document:{getElementById:id=>{if(!els.has(id))els.set(id,element());return els.get(id)},querySelector(){return null},querySelectorAll(){return []},addEventListener(){},createElement:element},ParentsAudioStorage:storage,DadsMusicAudioStorage:storage};c.window=c;
 vm.runInNewContext(source('app.js'),c);await turn();assert.equal(audioReady,true,'local startup cannot wait for worker registration');
}
(async()=>{
 const w=worker();w.entries.set('app.js?v=999',new Response('current release'));w.setNetwork(()=>new Promise(()=>{}));
 assert.equal(await(await w.request('app.js?v=1')).text(),'current release');assert.equal(w.calls(),0);
 const installed=new Promise(resolve=>w.handlers.install({waitUntil:p=>p.then(resolve)}));await installed;assert(w.installed.length);assert(w.installed.every(r=>r.cache==='reload'));
 let activation;w.handlers.activate({waitUntil:p=>activation=p});await activation;assert(!w.removed.includes('unrelated-shell'));
 assert.equal(w.request('https://example.test/sibling/app.js'),undefined);assert.equal(w.request('https://script.google.com/api'),undefined);assert.equal(w.request('app.js',{method:'POST'}),undefined);
 const fallback=worker();fallback.entries.set('./index.html',new Response('shell'));fallback.setNetwork(async()=>{throw Error('offline')});
 assert.equal(await(await fallback.request('./missing',{mode:'navigate'})).text(),'shell');assert.equal((await fallback.request('missing.js')).status,0);
 const miss=worker();assert.equal(await(await miss.request('new.css')).text(),'network');assert.equal(miss.calls(),1);
 if(source('app.js').includes('async function boot()'))await startup();
 console.log('PASS cached assets without network wait, previous HTML query versions, cache-miss fetch, offline navigation, isolated cleanup, reload installation'+(source('app.js').includes('async function boot()')?', nonblocking local audio startup':''));
})().catch(error=>{console.error(error);process.exitCode=1});
