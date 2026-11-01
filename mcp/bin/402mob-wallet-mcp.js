#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createWalletMcpServer} from '../src/server.js';

try{
  const {values}=parseArgs({strict:true,options:{dir:{type:'string'},origin:{type:'string'},adapter:{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.error('402mob-wallet-mcp --dir /absolute/private/directory [--origin https://evidence.contact] [--adapter /trusted/adapter.mjs]\nLocal stdio tools: wallet_readiness, wallet_status, wallet_bootstrap. Startup never creates a wallet.');}
  else{
    let adapter={};
    const adapterPath=values.adapter??process.env.A2A_WALLET_ADAPTER;
    if(adapterPath){
      const loaded=await import(pathToFileURL(resolve(adapterPath)).href);
      adapter=loaded.default??(typeof loaded.createWalletAdapter==='function'?await loaded.createWalletAdapter():{secretStore:loaded.secretStore,signer:loaded.signer,secretPrefix:loaded.secretPrefix});
      if(!adapter||typeof adapter!=='object'||Array.isArray(adapter)||!adapter.secretStore||Object.keys(adapter).some(k=>!['secretStore','signer','secretPrefix'].includes(k)))throw new Error('Invalid adapter');
    }
    const server=createWalletMcpServer({directory:values.dir??process.env.A2A_WALLET_DIR,origin:values.origin??'https://evidence.contact',adapter});
    await server.connect(new StdioServerTransport());
    const stop=()=>server.close().catch(()=>{});
    process.stdin.once('end',stop);
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  }
}catch{
  console.error('Wallet MCP startup failed. Check the absolute directory, origin, trusted adapter and dependencies. No credential details are logged.');
  process.exitCode=1;
}
