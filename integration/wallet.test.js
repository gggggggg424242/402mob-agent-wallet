import nodeTest from 'node:test';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat, chmod, readdir, writeFile, mkdir } from 'node:fs/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { AgentWallet } from '../src/wallet.js';
const serviceRoot=process.env.MOB402_SERVICE_SOURCE;
const test=(name,run)=>nodeTest(name,{skip:serviceRoot?false:'Set MOB402_SERVICE_SOURCE to a 402Mob service checkout'},run);
const createApp=serviceRoot?(await import(pathToFileURL(join(serviceRoot,'src/app.ts')).href)).createApp:undefined;
const Toolkit=serviceRoot?(await import(pathToFileURL(join(serviceRoot,'src/toolkit.ts')).href)).Toolkit:undefined;

const tx=`0x${'ab'.repeat(32)}`;
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'402mob-wallet-test-'));
  const config={host:'127.0.0.1',port:0,origin:'http://localhost:4020',database:join(dir,'app.db'),encryptionKey:Buffer.alloc(32,9),adminToken:'test-admin-'.repeat(5),
    merchant:'0x3333333333333333333333333333333333333333',facilitator:'https://facilitator.invalid',rpc:'https://rpc.invalid',retentionMs:86400000,maxResultBytes:1048576,confirmations:3n};
  const toolkit=new Toolkit(config);let app;const server=createServer((req,res)=>app(req,res)).listen(0,'127.0.0.1');await once(server,'listening');
  config.origin=`http://127.0.0.1:${server.address().port}`;app=createApp(toolkit);
  // Only network settlement and chain reads are mocked. Actual API validation and all wallet signatures run.
  t.mock.method(toolkit.payments,'verify',async()=>{});
  const settle=t.mock.method(toolkit.payments,'settle',async payment=>({success:true,transaction:tx,network:'eip155:8453',payer:payment.payload.authorization.from}));
  const confirm=t.mock.method(toolkit.payments,'confirm',async op=>({success:true,transaction:tx,network:'eip155:8453',payer:op.payer}));
  t.mock.method(toolkit.payments.chain,'getChainId',async()=>8453);
  t.mock.method(toolkit.payments.chain,'getBlockNumber',async()=>100n);
  const wallets=[];
  t.after(async()=>{for(const w of wallets)await w.close();await new Promise(r=>server.close(r));toolkit.store.close();await rm(dir,{recursive:true,force:true});});
  async function wallet(name,fetcher=fetch,options={}) {
    const w=await AgentWallet.open({directory:join(dir,name),origin:config.origin,fetcher,...options});wallets.push(w);return w;
  }
  async function sale() {
    const seller=await wallet('seller');await seller.bootstrap('Seller Agent');
    const offer=await seller.publish({title:'Agent data',description:'Small prepared artifact',priceUSDC:'0.02',contentType:'application/json',result:{answer:42}});
    await seller.discovery(true);
    return {seller,offer,terms:{id:'task-1',merchantId:seller.status().merchant.id,offerId:offer.id,payee:seller.status().address,maxUSDC:'0.02'}};
  }
  return {dir,origin:config.origin,toolkit,settle,confirm,wallet,sale};
}

test('zero-fund enrollment persists identity, hides secrets, discovers and reopens',async t=>{
  const f=await fixture(t),w=await f.wallet('agent');const before=w.status().address;
  const result=await w.bootstrap('Autonomous Agent');assert.equal(result.address,before);assert.ok(result.enrolled);
  assert.equal('privateKey' in result,false);assert.equal('apiKey' in result,false);assert.equal(JSON.stringify(w),'{}');
  const path=join(f.dir,'agent','wallet.json');const secrets=JSON.parse(await readFile(path,'utf8'));
  assert.equal((await stat(path)).mode & 0o777,0o600);
  assert.equal((await stat(join(f.dir,'agent'))).mode & 0o777,0o700);
  await w.close();const reopened=await f.wallet('agent');assert.equal(reopened.status().address,before);
  await reopened.bootstrap();assert.equal(JSON.parse(await readFile(path,'utf8')).apiKey,secrets.apiKey);
  assert.deepEqual(await reopened.inbox(),{tickets:[]});assert.equal(f.settle.mock.callCount(),0);
});

test('a lost enrollment response recovers the same identity by rotating its credential',async t=>{
  const f=await fixture(t);let lost=false;
  const w=await f.wallet('agent',async(url,options)=>{const r=await fetch(url,options);if(String(url).endsWith('/enrollments')&&!lost){lost=true;await r.arrayBuffer();throw new Error('dropped response');}return r;});
  const address=w.status().address;await assert.rejects(w.bootstrap('Recovery Agent'));
  assert.equal((await w.bootstrap()).address,address);assert.ok(w.status().enrolled);
});

test('wrong-origin challenge is never signed or submitted',async t=>{
  const f=await fixture(t);let submitted=false;
  const w=await f.wallet('agent',async(url,options)=>{
    if(String(url).endsWith('/enrollments'))submitted=true;
    const r=await fetch(url,options);
    if(String(url).endsWith('/enrollment-challenges')){const d=await r.json();d.message=d.message.replace(f.origin,'https://evil.invalid');return Response.json(d,{status:201});}return r;
  });
  await assert.rejects(w.bootstrap(),/does not match/);assert.equal(submitted,false);
});

test('two agents publish, discover, purchase once, recover, acknowledge and inspect sale',async t=>{
  const f=await fixture(t),{seller,terms}=await f.sale(),buyer=await f.wallet('buyer');
  const found=await buyer.discover('Agent data');assert.equal(found.items.length,1);
  const result=await buyer.purchase(terms);assert.deepEqual(JSON.parse(result.content),{answer:42});
  assert.equal(f.settle.mock.callCount(),1);assert.equal((await buyer.resume('task-1')).replay,true);
  await buyer.acknowledge('task-1','accepted');
  assert.equal((await seller.sales()).sales.length,1);
  const receipts=f.toolkit.store.deliveryReceipts(result.operationId);assert.equal(receipts[0].verdict,'accepted');
  assert.equal(f.settle.mock.callCount(),1);
});

test('price cap and recipient mismatch cause no payment authorization or settlement',async t=>{
  const f=await fixture(t),{terms}=await f.sale(),buyer=await f.wallet('buyer');
  await assert.rejects(buyer.purchase({...terms,maxUSDC:'0.01'}),/does not match/);
  await assert.rejects(buyer.purchase({...terms,payee:'0x4444444444444444444444444444444444444444'}),/does not match/);
  assert.equal((await readdir(join(f.dir,'buyer'))).some(x=>x.startsWith('purchase-')),false);
  assert.equal(f.settle.mock.callCount(),0);
});

test('dropped paid response survives process restart and reuses exact signed payment',async t=>{
  const f=await fixture(t),{terms}=await f.sale();let firstHeader;
  let buyer=await f.wallet('buyer',async(url,options)=>{
    if(options.headers?.['PAYMENT-SIGNATURE']){
      const journal=JSON.parse(await readFile(join(f.dir,'buyer','purchase-task-1.json'),'utf8'));
      firstHeader=options.headers['PAYMENT-SIGNATURE'];assert.equal(journal.paymentHeader,firstHeader);
      const r=await fetch(url,options);await r.arrayBuffer();throw new Error('response lost after settlement');
    }return fetch(url,options);
  });
  await assert.rejects(buyer.purchase(terms));assert.equal(f.settle.mock.callCount(),1);await buyer.close();
  buyer=await f.wallet('buyer',async(url,options)=>{if(options.headers?.['PAYMENT-SIGNATURE'])assert.equal(options.headers['PAYMENT-SIGNATURE'],firstHeader);return fetch(url,options);});
  const recovered=await buyer.resume('task-1');assert.equal(recovered.status,'delivered');assert.equal(f.settle.mock.callCount(),1);
  await assert.rejects(buyer.purchase({...terms,offerId:'00000000-0000-4000-8000-000000000001'}),/different terms/);
});

test('pending payment stays unresolved and resume never settles a second time',async t=>{
  const f=await fixture(t),{terms}=await f.sale(),buyer=await f.wallet('buyer');
  f.confirm.mock.mockImplementation(async()=>null);
  const pending=await buyer.purchase(terms);assert.equal(pending.status,'pending');
  assert.equal((await buyer.resume('task-1')).status,'pending');assert.equal(f.settle.mock.callCount(),1);
  f.confirm.mock.mockImplementation(async op=>({success:true,transaction:tx,network:'eip155:8453',payer:op.payer}));
  await f.toolkit.reconcile(pending.operationId,tx);
  assert.equal((await buyer.resume('task-1')).status,'delivered');assert.equal(f.settle.mock.callCount(),1);
});

test('exclusive lock, origin binding and private-file permissions fail closed',async t=>{
  const f=await fixture(t),w=await f.wallet('agent');
  await assert.rejects(f.wallet('agent'),/locked/);await w.close();
  await assert.rejects(AgentWallet.open({directory:join(f.dir,'agent'),origin:'https://evil.invalid'}),/different service/);
  await chmod(join(f.dir,'agent','wallet.json'),0o644);
  await assert.rejects(f.wallet('agent'),/permissions/);
});

test('CLI help and invalid command are structured JSON and do not require credentials',()=>{
  const cli=new URL(process.env.WALLET_PACKAGED_CLI ? 'file://'+process.env.WALLET_PACKAGED_CLI : '../bin/402mob-wallet.js',import.meta.url);
  const help=spawnSync(process.execPath,[cli.pathname,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.ok(JSON.parse(help.stdout).commands.bootstrap);
  const bad=spawnSync(process.execPath,[cli.pathname,'bootstrap','--max-usdc','0.02'],{encoding:'utf8'});
  assert.equal(bad.status,1);assert.equal(JSON.parse(bad.stderr).error,'wallet_error');
});

test('a payment challenge with a substituted chain, asset or URL never gets signed',async t=>{
  const f=await fixture(t),{terms}=await f.sale();
  const mutations=[c=>{c.accepts[0].network='eip155:1';},c=>{c.accepts[0].asset='0x4444444444444444444444444444444444444444';},c=>{c.resource.url='https://evil.invalid/checkout';}];
  for(const [i,mutate] of mutations.entries()){
    let submitted=false;
    const w=await f.wallet(`guard-${i}`,async(url,options)=>{
      if(options.headers?.['PAYMENT-SIGNATURE'])submitted=true;
      const r=await fetch(url,options);if(r.status!==402)return r;
      const c=JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'),'base64').toString());await r.body.cancel();mutate(c);
      return new Response('{}',{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(c)).toString('base64')}});
    });
    await assert.rejects(w.purchase(terms));assert.equal(submitted,false);
    assert.equal((await readdir(join(f.dir,`guard-${i}`))).some(x=>x.startsWith('purchase-')),false);
  }
  assert.equal(f.settle.mock.callCount(),0);
});

test('a malformed settlement receipt does not mark a purchase delivered',async t=>{
  const f=await fixture(t),{terms}=await f.sale();let tamper=true;
  const w=await f.wallet('buyer',async(url,options)=>{
    const r=await fetch(url,options);
    if(tamper && options.headers?.['PAYMENT-SIGNATURE'] && r.status===200){
      const headers=new Headers(r.headers);headers.delete('PAYMENT-RESPONSE');return new Response(await r.arrayBuffer(),{status:200,headers});
    }return r;
  });
  await assert.rejects(w.purchase(terms),/Missing settlement receipt/);
  assert.equal(JSON.parse(await readFile(join(f.dir,'buyer','purchase-task-1.json'),'utf8')).result,undefined);
  tamper=false;assert.equal((await w.resume('task-1')).status,'delivered');assert.equal(f.settle.mock.callCount(),1);
});

test('concurrent purchase calls on one wallet cannot create competing authorizations',async t=>{
  const f=await fixture(t),{terms}=await f.sale(),w=await f.wallet('buyer');
  const first=w.purchase(terms);
  await assert.rejects(w.purchase(terms),/already running/);
  await first;assert.equal(f.settle.mock.callCount(),1);
  await w.close();await assert.rejects(w.purchase(terms),/closed/);
});


test('CLI bootstrap enrolls without prompts and reuses the saved wallet on its next invocation',async t=>{
  const f=await fixture(t),cli=process.env.WALLET_PACKAGED_CLI ?? new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  const args=[cli,'bootstrap','--dir',join(f.dir,'cli-agent'),'--origin',f.origin,'--name','CLI Agent'];
  const run=promisify(execFile);
  const first=await run(process.execPath,args,{timeout:15000});
  const second=await run(process.execPath,args,{timeout:15000});
  const a=JSON.parse(first.stdout),b=JSON.parse(second.stdout);
  assert.equal(a.enrolled,true);assert.equal(a.address,b.address);assert.equal(a.merchant.id,b.merchant.id);
  const secrets=JSON.parse(await readFile(join(f.dir,'cli-agent','wallet.json'),'utf8'));
  for(const output of [first.stdout,first.stderr,second.stdout,second.stderr]){
    assert.equal(output.includes(secrets.privateKey),false);assert.equal(output.includes(secrets.apiKey),false);
  }
  assert.equal(f.settle.mock.callCount(),0);
});

function vault() {
  const values=new Map();
  return {values,get:key=>values.get(key),set:(key,value)=>{values.set(key,value);}};
}

test('secret-store EOA survives restart and enrollment with no local key file',async t=>{
  const f=await fixture(t),secretStore=vault();
  let w=await f.wallet('vault-agent',fetch,{secretStore});const address=w.status().address;
  assert.match(JSON.parse([...secretStore.values.values()][0]).privateKey,/^0x[0-9a-f]{64}$/);
  await w.bootstrap(' Vault Agent ');const merchant=w.status().merchant.id;
  await assert.rejects(readFile(join(f.dir,'vault-agent','wallet.json')),/ENOENT/);
  await w.close();w=await f.wallet('vault-agent',fetch,{secretStore});
  await w.bootstrap();assert.equal(w.status().address,address);assert.equal(w.status().merchant.id,merchant);
  assert.equal(f.settle.mock.callCount(),0);
});

test('missing vault secret cannot replace an existing wallet or contact the service',async t=>{
  const f=await fixture(t),secretStore=vault(),w=await f.wallet('vault-agent',fetch,{secretStore});
  await w.close();secretStore.values.clear();let requests=0;
  await assert.rejects(f.wallet('vault-agent',()=>{requests++;},{secretStore}),/secret is missing/);
  assert.equal(secretStore.values.size,0);assert.equal(requests,0);
});

test('storage switching and substituted vault identities are rejected',async t=>{
  const f=await fixture(t),secretStore=vault(),w=await f.wallet('file-agent');await w.close();
  await assert.rejects(f.wallet('file-agent',fetch,{secretStore}),/storage changed|file wallet/);
  assert.equal(secretStore.values.size,0);
  const v=await f.wallet('vault-agent',fetch,{secretStore});await v.close();
  await assert.rejects(f.wallet('vault-agent'),/storage changed/);
  await assert.rejects(f.wallet('vault-agent',fetch,{secretStore,secretPrefix:'another-agent'}),/storage changed/);
  const key=[...secretStore.values.keys()][0],state=JSON.parse(secretStore.values.get(key));
  state.privateKey=generatePrivateKey();secretStore.set(key,JSON.stringify(state));
  await assert.rejects(f.wallet('vault-agent',fetch,{secretStore}),/identity changed/);
});

test('managed signer enrolls without exporting its key and requires typed signing only for buying',async t=>{
  const f=await fixture(t),secretStore=vault(),account=privateKeyToAccount(generatePrivateKey());let signed=0;
  const signer={address:account.address,signMessage:args=>{signed++;return account.signMessage(args);}};
  let w=await f.wallet('managed',fetch,{secretStore,signer});await w.bootstrap('Managed Agent');
  assert.equal(signed,1);const stored=[...secretStore.values.values()][0];
  assert.equal(JSON.parse(stored).privateKey,undefined);assert.equal(JSON.parse(stored).walletAddress,account.address);
  await assert.rejects(w.purchase({}),/typed data/);await w.close();
  w=await f.wallet('managed',fetch,{secretStore,signer});await w.bootstrap();assert.equal(signed,1);await w.close();
  await assert.rejects(f.wallet('managed',fetch,{secretStore,signer:privateKeyToAccount(generatePrivateKey())}),/does not match/);
});

test('vault write failure aborts before networking and releases the process lock',async t=>{
  const f=await fixture(t);let requests=0;
  const secretStore={get:()=>undefined,set:()=>{throw new Error('vault unavailable');}};
  await assert.rejects(f.wallet('write-failure',()=>{requests++;},{secretStore}),/vault unavailable/);
  assert.equal(requests,0);
  const w=await f.wallet('write-failure',fetch,{secretStore:vault()});assert.equal(w.status().enrolled,false);
});

test('corrupt vault data is preserved rather than replaced',async t=>{
  const f=await fixture(t),secretStore=vault();secretStore.set(`402mob/agent-wallet:${f.origin}`,'broken-json');
  await assert.rejects(f.wallet('broken-vault',fetch,{secretStore}));
  assert.equal([...secretStore.values.values()][0],'broken-json');
});

test('all enrollment requests reject redirects before sending proofs elsewhere',async t=>{
  const f=await fixture(t);let requests=0;
  const w=await f.wallet('redirects',async(url,options)=>{requests++;assert.equal(options.redirect,'error');return fetch(url,options);});
  await w.bootstrap('Redirect Guard');assert.equal(requests,2);
});

test('expired and substituted enrollment challenges are never signed by managed signers',async t=>{
  const f=await fixture(t),account=privateKeyToAccount(generatePrivateKey());let signed=0;
  const mutations=[c=>{c.expiresAt=new Date(0).toISOString();},c=>{c.message=c.message.replace('Merchant name: Guard','Merchant name: Attacker');},c=>{c.transactionProof.network='eip155:1';}];
  for(const [i,mutate] of mutations.entries()){
    const w=await f.wallet(`challenge-${i}`,async(url,options)=>{const r=await fetch(url,options);const c=await r.json();mutate(c);return Response.json(c,{status:r.status});},
      {secretStore:vault(),signer:{address:account.address,signMessage:args=>{signed++;return account.signMessage(args);}}});
    await assert.rejects(w.bootstrap('Guard'));
  }
  assert.equal(signed,0);
});

test('CLI missing arguments and incomplete adapters fail before creating a wallet',async t=>{
  const f=await fixture(t),cli=process.env.WALLET_PACKAGED_CLI ?? new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  const adapter=join(f.dir,'empty-adapter.mjs');await writeFile(adapter,'export default {};');
  for(const args of [['purchase'],['bootstrap','--adapter',adapter]]){
    const dir=join(f.dir,'should-not-exist');const r=spawnSync(process.execPath,[cli,...args,'--dir',dir],{encoding:'utf8'});
    assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).error,'wallet_error');await assert.rejects(stat(dir),/ENOENT/);
  }
});

test('CLI async adapter persists a managed signer enrollment across processes without printing secrets',async t=>{
  const f=await fixture(t),cli=process.env.WALLET_PACKAGED_CLI ?? new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  const vaultPath=join(f.dir,'test-vault.json'),adapter=join(f.dir,'test-adapter.mjs');
  // Test-only file vault. Production adapters must use an encrypted runtime store.
  await writeFile(adapter,`import {readFile,writeFile} from 'node:fs/promises'; export async function createWalletAdapter(){return {secretStore:{get:async()=>{try{return await readFile(${JSON.stringify(vaultPath)},'utf8');}catch(e){if(e.code==='ENOENT')return undefined;throw e;}},set:async(k,v)=>writeFile(${JSON.stringify(vaultPath)},v,{mode:0o600})}};}`);
  const run=promisify(execFile),args=[cli,'bootstrap','--adapter',adapter,'--dir',join(f.dir,'cli-vault'),'--origin',f.origin,'--name','Adapter Agent'];
  const a=await run(process.execPath,args,{timeout:15000}),b=await run(process.execPath,args,{timeout:15000});
  assert.equal(JSON.parse(a.stdout).enrolled,true);assert.equal(JSON.parse(a.stdout).address,JSON.parse(b.stdout).address);
  const secret=JSON.parse(await readFile(vaultPath,'utf8'));
  for(const output of [a.stdout,a.stderr,b.stdout,b.stderr]){assert.equal(output.includes(secret.privateKey),false);assert.equal(output.includes(secret.apiKey),false);}
  await assert.rejects(readFile(join(f.dir,'cli-vault','wallet.json')),/ENOENT/);
});

test('release recipe, archive and discovery metadata identify the same tested wallet',async t=>{
  const {createHash}=await import('node:crypto');
  const recipe=JSON.parse(await readFile(join(serviceRoot,'public/agent-wallet.json'),'utf8'));
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const agent=JSON.parse(await readFile(join(serviceRoot,'public/agent.json'),'utf8'));
  const release=agent.services.find(s=>s.id==='agent-controlled-wallet');
  assert.equal(recipe.version,pkg.version);assert.equal(release.version,pkg.version);assert.equal(release.download,recipe.download);
  const f=await fixture(t),cap=(await (await fetch(f.origin+'/v1/capabilities')).json()).agentWallet;
  assert.equal(cap.version,recipe.version);assert.equal(cap.sha256,recipe.sha256);assert.equal(cap.creationPolicy,recipe.creationPolicy);
  assert.equal((await fetch(cap.adapterTemplate)).status,200);
  const archive=await readFile(join(serviceRoot,`public/downloads/402mob-agent-wallet-${pkg.version}.tgz`));
  assert.equal(createHash('sha256').update(archive).digest('hex'),recipe.sha256);
  assert.equal(recipe.bootstrap.fundingRequired,false);assert.equal(recipe.bootstrap.operatorTokenRequired,false);
  assert.ok(recipe.bootstrap.command.includes(`--package=${recipe.package}@${recipe.npmPublishedVersion}`));
  assert.ok(recipe.bootstrap.invocation.args.includes(`--package=${recipe.package}@${recipe.npmPublishedVersion}`));
  for(const path of ['agent-wallet.md','llm.txt','docs.html','index.html'])assert.ok((await readFile(join(serviceRoot,'public',path),'utf8')).includes('agent-wallet'));
});

test('closed wallets cannot call merchant or public APIs after releasing their lock',async t=>{
  const f=await fixture(t),w=await f.wallet('closed');await w.bootstrap('Closed Agent');await w.close();
  for(const action of [()=>w.offers(),()=>w.publish({}),()=>w.discovery(true),()=>w.sales(),()=>w.inbox(),()=>w.claim('x'),()=>w.quote('x',{}),()=>w.deliver('x',{}),()=>w.discover(),()=>w.provider('x'),()=>w.balance()])
    await assert.rejects(action(),/closed/);
});

test('an active merchant request holds the wallet lock until completion',async t=>{
  const f=await fixture(t);let block=false,release;
  const gate=new Promise(r=>{release=r;});
  const w=await f.wallet('busy',async(url,options)=>{if(block)await gate;return fetch(url,options);});
  await w.bootstrap('Busy Agent');block=true;
  const request=w.offers();await assert.rejects(w.close(),/active wallet operation/);await assert.rejects(w.sales(),/already running/);
  release();await request;await w.close();
});

test('corrupt local wallet JSON is preserved and cannot generate another identity',async t=>{
  const f=await fixture(t),w=await f.wallet('corrupt-file');await w.close();
  const path=join(f.dir,'corrupt-file','wallet.json');await writeFile(path,'broken-json');
  await assert.rejects(f.wallet('corrupt-file'));assert.equal(await readFile(path,'utf8'),'broken-json');
});

test('a corrupt purchase journal cannot authorize a second payment',async t=>{
  const f=await fixture(t),{terms}=await f.sale(),w=await f.wallet('buyer');await w.purchase(terms);
  const path=join(f.dir,'buyer','purchase-task-1.json');await writeFile(path,'broken-json');
  await assert.rejects(w.purchase(terms));assert.equal(f.settle.mock.callCount(),1);assert.equal(await readFile(path,'utf8'),'broken-json');
});

test('a tampered cached artifact is recovered from the same operation without paying again',async t=>{
  const f=await fixture(t),{terms}=await f.sale(),w=await f.wallet('buyer'),result=await w.purchase(terms);
  const path=join(f.dir,'buyer','purchase-task-1.json'),j=JSON.parse(await readFile(path,'utf8'));
  j.result.content='substituted content';await writeFile(path,JSON.stringify(j));
  const recovered=await w.resume('task-1');assert.equal(recovered.operationId,result.operationId);assert.deepEqual(JSON.parse(recovered.content),{answer:42});assert.equal(f.settle.mock.callCount(),1);
});

test('opening an existing wallet never replaces missing state when creation is disabled',async t=>{
  const f=await fixture(t),directory=join(f.dir,'not-created');
  await assert.rejects(AgentWallet.open({directory,createIfMissing:false}),/directory does not exist/);
  await assert.rejects(stat(directory),/ENOENT/);
  const w=await f.wallet('existing');const address=w.status().address;await w.close();
  const reopened=await f.wallet('existing',fetch,{createIfMissing:false});assert.equal(reopened.status().address,address);
  const secretStore=vault();let sets=0;secretStore.set=()=>{sets++;};
  await mkdir(join(f.dir,'empty-store'),{mode:0o700});
  await assert.rejects(f.wallet('empty-store',fetch,{secretStore,createIfMissing:false}),/No saved wallet/);assert.equal(sets,0);
});

test('CLI status, balance and discovery on an unknown directory cannot create an identity',async t=>{
  const f=await fixture(t),cli=process.env.WALLET_PACKAGED_CLI ?? new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  for(const command of ['status','balance','discover']){
    const directory=join(f.dir,`unknown-${command}`),r=spawnSync(process.execPath,[cli,command,'--dir',directory],{encoding:'utf8'});
    assert.equal(r.status,1);assert.match(JSON.parse(r.stderr).message,/bootstrap/);await assert.rejects(stat(directory),/ENOENT/);
  }
});

test('a shell-free bootstrap recipe enrolls using the installed CLI and explicit substitutions',async t=>{
  const f=await fixture(t),recipe=JSON.parse(await readFile(join(serviceRoot,'public/agent-wallet.json'),'utf8'));
  const invocation=recipe.bootstrap.invocation,args=invocation.args.slice(invocation.args.indexOf('--')+2).map(value=>({'<absolute-private-directory>':join(f.dir,'recipe-agent'),'<merchant-name>':'Recipe Agent'}[value] ?? value));
  const cli=process.env.WALLET_PACKAGED_CLI ?? new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  const r=await promisify(execFile)(process.execPath,[cli,...args,'--origin',f.origin],{timeout:15000});
  const result=JSON.parse(r.stdout);assert.equal(result.enrolled,true);
  assert.match(result.address,/^0x[0-9a-fA-F]{40}$/);
  assert.match(result.merchant.id,/^[0-9a-f-]{36}$/i);
  assert.equal(result.merchant.payoutAddress.toLowerCase(),result.address.toLowerCase());
  assert.equal(f.settle.mock.callCount(),0);
});
