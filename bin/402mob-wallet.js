#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentWallet, WalletError } from '../src/wallet.js';

const commands={bootstrap:['name'],status:[],balance:['rpc'],discover:['query'],provider:['merchant'],offers:[],publish:['file'],discovery:['enabled'],sales:[],inbox:[],claim:['ticket'],quote:['ticket','file'],deliver:['ticket','file'],purchase:['id','merchant','offer','max-usdc','payee'],resume:['id'],ack:['id','verdict']};
const help={usage:'402mob-wallet <command> [--dir <private-directory>] [--origin <service-origin>] [--adapter <trusted-module.mjs>]',commands,
  notes:['bootstrap creates or reopens a local wallet and enrolls without gas or browser interaction.',
    'Only bootstrap creates a wallet. Other commands require saved state in the same --dir and adapter.',
    'A trusted adapter module can provide an encrypted secretStore and optional signer; use --adapter or A2A_WALLET_ADAPTER.',
    'publish/quote/deliver take a JSON file matching the merchant API schema.',
    'purchase spends real Base USDC: supply a stable --id, exact --payee and --max-usdc.',
    'resume reuses the saved payment. Keep the wallet directory private and backed up.',
    'discovery --enabled true opts into public search; ack requires --verdict accepted or disputed.']};
let wallet;
try {
  const {positionals,values}=parseArgs({allowPositionals:true,strict:true,options:{
    help:{type:'boolean',short:'h'},...Object.fromEntries(['dir','origin','adapter',...new Set(Object.values(commands).flat())].map(x=>[x,{type:'string'}]))}});
  const command=positionals[0];
  if (values.help || !command) { console.log(JSON.stringify(help,null,2)); }
  else {
    if (!Object.hasOwn(commands,command) || positionals.length!==1) throw new WalletError('Unknown command; use --help.');
    for(const key of Object.keys(values)) if(!['dir','origin','adapter',...commands[command]].includes(key)) throw new WalletError(`Unsupported --${key} for ${command}.`);
    const need=(key)=>{if(!values[key])throw new WalletError(`Missing --${key}.`);return values[key];};
    for (const key of commands[command]) if (!['name','rpc','query'].includes(key)) need(key);
    const file=async()=>{const f=await open(need('file'),'r');try{const s=await f.stat();if(!s.isFile()||s.size>64*1024)throw new WalletError('Input file must be JSON at most 64 KiB.');return JSON.parse(await f.readFile('utf8'));}finally{await f.close();}};
    let adapter={};
    const adapterPath=values.adapter ?? process.env.A2A_WALLET_ADAPTER;
    if(adapterPath){
      const loaded=await import(pathToFileURL(resolve(adapterPath)).href);
      adapter=loaded.default ?? (typeof loaded.createWalletAdapter==='function' ? await loaded.createWalletAdapter() :
        {secretStore:loaded.secretStore,signer:loaded.signer,secretPrefix:loaded.secretPrefix});
      if(!adapter || typeof adapter!=='object' || Array.isArray(adapter))throw new WalletError('Adapter module must export a default object or createWalletAdapter().');
      for(const key of Object.keys(adapter))if(!['secretStore','signer','secretPrefix'].includes(key))throw new WalletError(`Unsupported wallet adapter field: ${key}.`);
      if(!adapter.secretStore)throw new WalletError('Adapter must provide secretStore; refusing to fall back to unencrypted file storage.');
    }
    wallet=await AgentWallet.open({directory:values.dir ?? process.env.A2A_WALLET_DIR ?? '.local/agent-wallet',origin:values.origin,...adapter,createIfMissing:command==='bootstrap'});
    let result;
    switch(command) {
      case 'bootstrap': result=await wallet.bootstrap(values.name);break;
      case 'status': result=wallet.status();break;
      case 'balance': result=await wallet.balance(values.rpc);break;
      case 'discover': result=await wallet.discover(values.query);break;
      case 'provider': result=await wallet.provider(need('merchant'));break;
      case 'offers': result=await wallet.offers();break;
      case 'publish': result=await wallet.publish(await file());break;
      case 'discovery': if(!['true','false'].includes(need('enabled')))throw new WalletError('--enabled must be true or false.');result=await wallet.discovery(values.enabled==='true');break;
      case 'sales': result=await wallet.sales();break;
      case 'inbox': result=await wallet.inbox();break;
      case 'claim': result=await wallet.claim(need('ticket'));break;
      case 'quote': result=await wallet.quote(need('ticket'),await file());break;
      case 'deliver': result=await wallet.deliver(need('ticket'),await file());break;
      case 'purchase': result=await wallet.purchase({id:need('id'),merchantId:need('merchant'),offerId:need('offer'),maxUSDC:need('max-usdc'),payee:need('payee')});break;
      case 'resume': result=await wallet.resume(need('id'));break;
      case 'ack': result=await wallet.acknowledge(need('id'),need('verdict'));break;
    }
    console.log(JSON.stringify(result,null,2));
  }
} catch(e) {
  // Never echo remote error messages, headers, signed payloads, private files or credentials.
  const message=e instanceof WalletError?e.message:'Wallet command failed. Check connectivity and input; retain the wallet directory and retry the same purchase ID.';
  console.error(JSON.stringify({error:'wallet_error',message}));process.exitCode=1;
} finally { if(wallet)await wallet.close(); }
