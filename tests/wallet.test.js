import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,unlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AgentWallet} from '../src/wallet.js';

async function directory(t){const parent=await mkdtemp(join(tmpdir(),'402mob-node-source-'));t.after(()=>rm(parent,{recursive:true,force:true}));return join(parent,'wallet');}
test('local EOA persists across reopen without contacting a service',async t=>{
  const dir=await directory(t);let address;
  const first=await AgentWallet.open({directory:dir,fetcher:()=>{throw new Error('Unexpected network');}});
  try{address=first.status().address;assert.match(address,/^0x[0-9a-fA-F]{40}$/);assert.equal(first.status().enrolled,false);assert.equal(JSON.stringify(first),'{}');assert.equal((await stat(join(dir,'wallet.json'))).mode&0o777,0o600);}finally{await first.close();}
  const reopened=await AgentWallet.open({directory:dir,createIfMissing:false});try{assert.equal(reopened.status().address,address);}finally{await reopened.close();}
});
test('an open wallet excludes another owner',async t=>{
  const dir=await directory(t),wallet=await AgentWallet.open({directory:dir});
  try{await assert.rejects(AgentWallet.open({directory:dir}),/locked/);}finally{await wallet.close();}
});
test('missing bound secret cannot be replaced by another EOA',async t=>{
  const dir=await directory(t),wallet=await AgentWallet.open({directory:dir});await wallet.close();await unlink(join(dir,'wallet.json'));
  await assert.rejects(AgentWallet.open({directory:dir}),/secret is missing/);
  await assert.rejects(readFile(join(dir,'wallet.json')),/ENOENT/);
});
test('closed wallet refuses network operations',async t=>{
  const dir=await directory(t),wallet=await AgentWallet.open({directory:dir});await wallet.close();
  await assert.rejects(wallet.bootstrap('Source Test'),/closed/);await assert.rejects(wallet.discover(),/closed/);
});
test('CLI help and unknown-directory status do not create an identity',async t=>{
  const dir=await directory(t),cli=new URL('../bin/402mob-wallet.js',import.meta.url).pathname;
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.ok(JSON.parse(help.stdout).commands.bootstrap);
  const status=spawnSync(process.execPath,[cli,'status','--dir',dir],{encoding:'utf8'});assert.equal(status.status,1);await assert.rejects(stat(dir),/ENOENT/);
});
