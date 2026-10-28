// Verify the visible local version and the exact files served by this app.
const fs=require('fs'),assert=require('node:assert/strict'),crypto=require('crypto'),{execFileSync}=require('child_process');
const release=JSON.parse(fs.readFileSync('version.json'));
const html=fs.readFileSync(release.html,'utf8'),worker=fs.readFileSync(release.worker,'utf8');
const remote=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim().replace(/\.git$/,'');
assert.equal(remote,'https://github.com/'+release.repository,'Wrong app repository');
if(process.env.GITHUB_REPOSITORY)assert.equal(process.env.GITHUB_REPOSITORY,release.repository);
assert.match(release.version,/^v\d+\.\d{2}$/);
assert(html.includes('data-app-version="'+release.version+'"'),'HTML version mismatch');
assert.equal((html.match(/id="appVersion"/g)||[]).length,1,'Exactly one visible version label');
assert(html.includes('data-version="'+release.version+'"'),'Visible version mismatch');
assert(worker.includes('// App version: '+release.version),'Worker version mismatch');
const files=[[release.html,release.url],[release.worker,new URL('sw.js',release.url).href]];
if(release.repository.endsWith('/lexi-spend'))files.push(['v2/app.js',new URL('app.js',release.url).href]);
if(process.argv.includes('--live'))(async()=>{
 for(const [file,url]of files){
  const response=await fetch(url+'?verify-version='+release.version,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  assert(response.ok,file+': HTTP '+response.status);
  const actual=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(file);
  assert.equal(crypto.createHash('sha256').update(actual).digest('hex'),crypto.createHash('sha256').update(expected).digest('hex'),'Live file mismatch: '+file);
 }
 console.log('VERIFIED '+release.url+' Version '+release.version);
})().catch(e=>{console.error(e);process.exitCode=1});
else console.log('PASS version '+release.version+' / '+release.repository);
