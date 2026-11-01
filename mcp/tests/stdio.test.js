import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const bin=process.env.WALLET_MCP_PACKAGED_BIN??new URL('../bin/402mob-wallet-mcp.js',import.meta.url).pathname;
async function fixture(t,args=[]){
 const root=await mkdtemp(join(tmpdir(),'402mob-wallet-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'wallet');
 const transport=new StdioClientTransport({command:process.execPath,args:[bin,'--dir',dir,'--origin','http://127.0.0.1:1',...args],stderr:'pipe'});
 const client=new Client({name:'wallet-test',version:'1.0.0'});await client.connect(transport);t.after(()=>client.close());
 return {root,dir,client,transport};
}
test('startup, discovery and readiness never create identity; strict tools cannot redirect storage',async t=>{
 const {dir,client}=await fixture(t);
 const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),['wallet_bootstrap','wallet_readiness','wallet_status']);
 const readiness=await client.callTool({name:'wallet_readiness',arguments:{}});
 assert.equal(readiness.structuredContent.ready,false);assert.equal(readiness.structuredContent.checks.network,false);
 const status=await client.callTool({name:'wallet_status',arguments:{}});assert.equal(status.isError,true);assert.equal(status.structuredContent.error,'wallet_missing');
 const injected=await client.callTool({name:'wallet_bootstrap',arguments:{directory:'/tmp/other-wallet',name:'Agent'}});assert.equal(injected.isError,true);
 await assert.rejects(stat(dir),/ENOENT/);
});
test('a missing bound secret is actionable and readiness does not claim state is usable',async t=>{
 const {dir,client}=await fixture(t);await mkdir(dir,{mode:0o700});
 await writeFile(join(dir,'identity.json'),JSON.stringify({version:1,origin:'http://127.0.0.1:1',storage:'file',address:'0x1111111111111111111111111111111111111111'}),{mode:0o600});
 const readiness=await client.callTool({name:'wallet_readiness',arguments:{}});assert.equal(readiness.structuredContent.checks.walletState,false);
 const result=await client.callTool({name:'wallet_bootstrap',arguments:{name:'Agent'}});assert.equal(result.structuredContent.error,'wallet_secret_missing');
 await assert.rejects(stat(join(dir,'wallet.json')),/ENOENT/);
});
test('adapter errors do not enter MCP payloads or stderr',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'402mob-wallet-adapter-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const secret='fixture_do_not_disclose_credential',adapter=join(parent,'adapter.mjs');
 await writeFile(adapter,`export default {secretStore:{get(){throw new Error('${secret}')},set(){throw new Error('${secret}')}}};`);
 const {client,transport}=await fixture(t,['--adapter',adapter]);let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
 const response=await client.callTool({name:'wallet_bootstrap',arguments:{name:'Agent'}});assert.equal(response.isError,true);
 assert.ok(!JSON.stringify(response).includes(secret));assert.ok(!stderr.includes(secret));
});
test('invalid startup fails without protocol chatter or echoed adapter errors',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'402mob-wallet-startup-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const adapter=join(parent,'bad.mjs');await writeFile(adapter,"throw new Error('private-fixture');");
 for(const args of [['--dir','relative/path'],['--dir',parent,'--adapter',adapter]]){
  const result=spawnSync(process.execPath,[bin,...args],{encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('private-fixture'));
 }
});
test('overlapping MCP tool calls report busy instead of opening another wallet',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'402mob-mcp-busy-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const adapter=join(parent,'adapter.mjs'),entered=join(parent,'entered'),gate=join(parent,'continue');
 await writeFile(adapter,`import {writeFile,access} from 'node:fs/promises'; let state; export default {secretStore:{async get(){await writeFile(${JSON.stringify(entered)},'ready'); for(let i=0;i<500;i++){try{await access(${JSON.stringify(gate)});return state;}catch{await new Promise(r=>setTimeout(r,10));}}throw new Error('test gate expired');},async set(k,v){state=v;}}};`);
 const {client}=await fixture(t,['--adapter',adapter]);
 const first=client.callTool({name:'wallet_bootstrap',arguments:{name:'Agent'}});
 try{
  let seen=false;for(let i=0;i<500;i++){try{await stat(entered);seen=true;break;}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.equal(seen,true);
  const overlapping=await client.callTool({name:'wallet_status',arguments:{}});assert.equal(overlapping.structuredContent.error,'wallet_busy');
 }finally{await writeFile(gate,'go');await first;}
});
