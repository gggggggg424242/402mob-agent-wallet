import {lstat,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,dirname,join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {AgentWallet,WalletError} from '402mob-agent-wallet';

const instructions='Local 402Mob wallet bridge. Call wallet_readiness first. wallet_status reads saved local state without verifying enrollment remotely. Only wallet_bootstrap creates an EOA, signs the exact enrollment challenge and enrolls; it may rotate a lost/invalid credential for the same identity, invalidating the previous key. Keys stay in the configured directory/vault. Keep that directory and adapter unchanged. No funding, publication, discovery opt-in or payment tools are exposed.';
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});

export function createWalletMcpServer({directory,origin='https://evidence.contact',adapter={},fetcher=globalThis.fetch}={}) {
  if(typeof directory!=='string'||!isAbsolute(directory))throw new WalletError('Configure an absolute private wallet directory with --dir or A2A_WALLET_DIR.');
  const url=new URL(origin);
  if(!((url.protocol==='https:')||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new WalletError('Configure an HTTPS service origin (loopback HTTP allowed).');
  origin=url.origin;
  if(!adapter||typeof adapter!=='object'||Array.isArray(adapter)||Object.keys(adapter).some(k=>!['secretStore','signer','secretPrefix'].includes(k))||
    (Object.keys(adapter).length>0&&(!adapter.secretStore||typeof adapter.secretStore.get!=='function'||typeof adapter.secretStore.set!=='function')))throw new WalletError('Configure a valid trusted secret-store adapter.');
  let busy=false;
  async function run(action){
    if(busy)return resultError('wallet_busy','Wait for the current wallet operation before retrying.');
    busy=true;
    try{return result(await action());}
    catch(error){
      // Adapter/API exception messages may contain secret values. Never forward them.
      const message=error instanceof WalletError?error.message:'';
      if(message.includes('secret is missing'))return resultError('wallet_secret_missing','Restore the original wallet secret from backup. Do not delete identity.json or create a replacement.');
      if(message.includes('locked'))return resultError('wallet_locked','Another process owns the wallet directory, or its lock is stale. Confirm the owner stopped before removing only .lock.');
      if(message.includes('does not exist')||message.includes('No saved wallet'))return resultError('wallet_missing','No saved wallet was found. Use the original directory, or call wallet_bootstrap if creating a new identity is intended.');
      if(message.includes('permissions')||message.includes('Unsafe private file'))return resultError('wallet_storage_unavailable','Check directory ownership and mode 0700, and private-file ownership and mode 0600. Preserve existing wallet files.');
      if(message.includes('different service origin')||message.includes('identity changed')||message.includes('storage changed'))return resultError('wallet_identity_mismatch','Restore the original directory, service origin and adapter. No replacement identity was created.');
      if(error?.status===429)return resultError('service_rate_limited','Wait before retrying the same bootstrap; retain the original identity.');
      return resultError('wallet_action_failed','Wallet action failed. Check readiness, connectivity, original storage and adapter. Retain identity; retry the same bootstrap after resolving the cause.');
    }finally{busy=false;}
  }
  function resultError(code,message){return {...result({error:code,message}),isError:true};}
  async function readiness(){
    const [major,minor]=process.versions.node.split('.').map(Number);
    const checks={runtime:(process.platform==='linux'||process.platform==='darwin')&&(major>22||(major===22&&minor>=13)),storage:false,walletState:true,network:false};
    let path=directory,existing=false;
    try{
      for(;;){
        try{const s=await lstat(path);if(path===directory){existing=true;checks.storage=s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0;}
          else checks.storage=s.isDirectory()&&!s.isSymbolicLink();
          await access(path,constants.W_OK|constants.X_OK);break;
        }catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(path);if(parent===path)break;path=parent;}
      }
    }catch{checks.storage=false;}
    if(existing){
      const exists=async name=>{try{await lstat(join(directory,name));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
      try{checks.walletState=!(await exists('.lock'))&&(!await exists('identity.json')||Boolean(adapter.secretStore)||await exists('wallet.json'));}catch{checks.walletState=false;}
    }
    try{const r=await fetcher(origin+'/healthz',{redirect:'error',signal:AbortSignal.timeout(5000)});checks.network=r.status===200;await r.body?.cancel();}catch{}
    return {ready:Object.values(checks).every(Boolean),checks,directoryExists:existing,walletCreated:false,adapterConfigured:Boolean(adapter.secretStore),nextAction:Object.values(checks).every(Boolean)?'Call wallet_status for an existing identity or wallet_bootstrap when creation/enrollment is intended.':'Resolve failed checks before bootstrap. A vault adapter must also be available and working.'};
  }
  async function withWallet(create,name){
    const wallet=await AgentWallet.open({directory,origin,...adapter,fetcher,createIfMissing:create});
    try{return create?await wallet.bootstrap(name):wallet.status();}finally{await wallet.close();}
  }
  const server=new McpServer({name:'402mob-wallet-local',version:'0.1.0'},{instructions});
  server.registerTool('wallet_readiness',{description:'Check runtime, storage location and service reachability without generating a key or requesting an enrollment challenge. Does not test the vault or signer.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},()=>run(readiness));
  server.registerTool('wallet_status',{description:'Read public saved wallet status from the fixed local directory/vault. Does not create a wallet or check the credential remotely. A missing identity is an error.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},()=>run(()=>withWallet(false)));
  server.registerTool('wallet_bootstrap',{description:'Create/reopen a local EOA, validate and sign the exact EIP-191 challenge, enroll and store the merchant credential. Gas-free. Retry using the same configured directory. Lost enrollment responses can require rotation that invalidates the previous merchant key. Returns only public identity fields.',inputSchema:z.object({name:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/).optional()}).strict(),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},({name})=>run(()=>withWallet(true,name)));
  return server;
}
