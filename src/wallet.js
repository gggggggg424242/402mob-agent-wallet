import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, parseUnits, formatUnits, isAddress, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { MerchantClient, MerchantApiError } from '402mob-merchant-sdk';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = { TransferWithAuthorization: [
  {name:'from',type:'address'}, {name:'to',type:'address'}, {name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'}, {name:'validBefore',type:'uint256'}, {name:'nonce',type:'bytes32'},
] };
export class WalletError extends Error {}
function check(condition, message) { if (!condition) throw new WalletError(message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function signerLike(value) {
  return record(value) && typeof value.address==='string' && isAddress(value.address) && typeof value.signMessage==='function' &&
    (value.signTypedData===undefined || typeof value.signTypedData==='function');
}
function validBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function originOf(value) {
  const u = new URL(value);
  check((u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) &&
    !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'Use an HTTPS origin (loopback HTTP allowed).');
  return u.origin;
}
function money(value) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(value), 'Use a USDC decimal string with at most six fractional digits.');
  const amount = parseUnits(value, 6); check(amount > 0n, 'Price cap must be positive.'); return amount;
}
function purchaseId(id) { check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id), 'Purchase ID must be 1–80 letters, digits, underscores or hyphens.'); return id; }
async function readPrivate(path) {
  let f;
  try { f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  try {
    const s = await f.stat();
    check(s.isFile() && (s.mode & 0o077) === 0 && s.uid === process.getuid() && s.size <= 16*1024*1024, 'Unsafe private file permissions, owner, type or size.');
    return JSON.parse(await f.readFile('utf8'));
  } finally { await f.close(); }
}
async function writePrivate(path, value) {
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const f = await open(temp, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
  await rename(temp, path);
  const d = await open(resolve(path, '..'), 'r'); try { await d.sync(); } finally { await d.close(); }
}
async function bodyBytes(response) {
  const reader = response.body?.getReader(); check(reader, 'Empty service response; preserve the wallet journal.');
  const parts = []; let size = 0;
  try {
    for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length;
      check(size <= 1024*1024, 'Service response exceeds 1 MiB.'); parts.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(parts);
}

/** One process owns the wallet directory until close(). Private material stays in private fields. */
export class AgentWallet {
  #dir; #state; #account; #lock; #fetch; #client; #busy=false; #secretStore; #secretKey;
  /**
   * Open a wallet using either a private local file, a secretStore, or a supplied signer.
   * secretStore implements async get(key) -> string|undefined and set(key, string).
   * signer has address and signMessage; signTypedData enables x402 purchases.
   */
  static async open({directory='.local/agent-wallet', origin, fetcher=globalThis.fetch, secretStore, signer, secretPrefix='402mob/agent-wallet', createIfMissing=true} = {}) {
    const walletOrigin=originOf(origin ?? 'https://evidence.contact');
    check(secretStore===undefined || (record(secretStore) && typeof secretStore.get==='function' && typeof secretStore.set==='function'), 'secretStore must implement async get(key) and set(key, value).');
    check(signer===undefined || signerLike(signer), 'signer must expose an EVM address and signMessage/signTypedData methods.');
    check(signer===undefined || secretStore!==undefined, 'A signer adapter requires secretStore to protect the merchant API key and wallet metadata.');
    check(typeof secretPrefix==='string' && /^[A-Za-z0-9._/-]{1,100}$/.test(secretPrefix), 'secretPrefix contains unsupported characters.');
    check(typeof createIfMissing==='boolean', 'createIfMissing must be a boolean.');
    const dir = resolve(directory);
    if (createIfMissing) await mkdir(dir, {recursive:true,mode:0o700});
    let s;
    try { s=await lstat(dir); }
    catch(e) { if(e.code==='ENOENT') throw new WalletError('Wallet directory does not exist. Use the original directory or run bootstrap explicitly to create a wallet.'); throw e; }
    check(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 && s.uid === process.getuid(), 'Wallet directory must be owned by this user with permissions 0700.');
    let lock;
    try { lock = await open(join(dir,'.lock'), 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new WalletError('Wallet is locked. If its process crashed, confirm it is stopped before removing .lock.'); throw e; }
    try {
      await lock.writeFile(String(process.pid));
      const secretKey=`${secretPrefix}:${walletOrigin}`;
      const bindingPath=join(dir,'identity.json');
      const binding=await readPrivate(bindingPath);
      const storage=secretStore ? `secretStore:${secretKey}` : 'file';
      if (binding !== undefined) {
        check(record(binding) && binding.version===1 && binding.storage===storage && isAddress(binding.address), 'Wallet identity or storage changed; restore the original store and directory.');
        check(binding.origin===walletOrigin, 'This wallet belongs to a different service origin.');
      }
      if (secretStore && await readPrivate(join(dir,'wallet.json')) !== undefined)
        throw new WalletError('This directory already contains a file wallet. Use its original storage or migrate it explicitly; no new identity was created.');
      let state;
      if (secretStore) {
        const encoded=await secretStore.get(secretKey);
        check(encoded===undefined || encoded===null || typeof encoded==='string', 'secretStore.get must return a JSON string or undefined.');
        state=encoded==null ? undefined : JSON.parse(encoded);
      } else state=await readPrivate(join(dir,'wallet.json'));
      if (state === undefined) {
        check(binding===undefined, 'Wallet secret is missing; restore it from backup. No replacement identity was created.');
        check(createIfMissing, 'No saved wallet exists in this directory or secret store. Use the original storage or run bootstrap explicitly to create a wallet.');
        state = {version:1,origin:walletOrigin,...(signer ? {walletAddress:signer.address} : {privateKey:generatePrivateKey()})};
        if (secretStore) await secretStore.set(secretKey,JSON.stringify(state));
        else await writePrivate(join(dir,'wallet.json'), state); // Identity survives every subsequent network failure.
      }
      check(record(state) && state.version === 1, 'Invalid wallet state; preserve it and restore your private backup.');
      check(originOf(state.origin) === state.origin && state.origin===walletOrigin, 'This wallet belongs to a different service origin.');
      let account;
      if (signer) {
        check(state.privateKey===undefined && typeof state.walletAddress==='string' && state.walletAddress.toLowerCase()===signer.address.toLowerCase(), 'The supplied signer does not match this stored wallet.');
        account=signer;
      } else {
        check(typeof state.privateKey === 'string' && /^0x[0-9a-f]{64}$/i.test(state.privateKey), 'Wallet key is unavailable; provide the same signer or restore its secret.');
        account=privateKeyToAccount(state.privateKey);
        check(state.walletAddress===undefined || state.walletAddress.toLowerCase()===account.address.toLowerCase(), 'Stored wallet address does not match its signing key.');
      }
      if (binding !== undefined) check(binding.address.toLowerCase()===account.address.toLowerCase(), 'Stored wallet identity changed; restore the original secret.');
      else await writePrivate(bindingPath,{version:1,origin:walletOrigin,storage,address:account.address});
      return new AgentWallet(dir,state,lock,fetcher,account,secretStore,secretKey);
    } catch (e) { await lock.close(); await unlink(join(dir,'.lock')); throw e; }
  }
  constructor(dir,state,lock,fetcher,account,secretStore,secretKey) {
    this.#dir=dir; this.#state=state; this.#lock=lock; this.#fetch=fetcher; this.#account=account;
    this.#secretStore=secretStore; this.#secretKey=secretKey;
    this.#client=new MerchantClient({baseUrl:state.origin,fetch:(url,options)=>this.#fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20_000)})});
  }
  async close() { check(!this.#busy, 'Wait for the active wallet operation before closing.'); if (this.#lock) { await this.#lock.close(); this.#lock=null; await unlink(join(this.#dir,'.lock')); } }
  async #exclusive(action) {
    check(this.#lock, 'Wallet is closed.');
    check(!this.#busy, 'Wallet is already running an operation; wait before retrying.');
    this.#busy=true;
    try { return await action(); } finally { this.#busy=false; }
  }
  bootstrap(name) { return this.#exclusive(()=>this.#bootstrap(name)); }
  purchase(input) { return this.#exclusive(()=>this.#purchase(input)); }
  resume(id) { return this.#exclusive(()=>this.#resume(id)); }
  acknowledge(id,verdict) { return this.#exclusive(()=>this.#acknowledge(id,verdict)); }
  #save() {
    return this.#secretStore ? this.#secretStore.set(this.#secretKey,JSON.stringify(this.#state)) : writePrivate(join(this.#dir,'wallet.json'),this.#state);
  }
  #merchant() { check(this.#state.apiKey, 'Run bootstrap first.'); return this.#client.withApiKey(this.#state.apiKey); }
  status() { return {address:this.#account.address,network:'eip155:8453',origin:this.#state.origin,enrolled:Boolean(this.#state.apiKey),merchant:this.#state.merchant ?? null}; }
  async #request(path, body, headers={}) {
    return this.#fetch(this.#state.origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30_000),
      headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async #json(path,body,headers) {
    const r=await this.#request(path,body,headers); check(r.ok,`Service rejected request (HTTP ${r.status}); retain recovery data.`);
    return JSON.parse((await bodyBytes(r)).toString());
  }
  async #enrollmentSignature(c, rotating) {
    const issued=c.message?.match(/^Issued: (.+)$/m)?.[1]; const now=Date.now();
    check(uuid.test(c.challengeId) && isAddress(c.transactionProof?.proofAddress) &&
      c.transactionProof.network==='eip155:8453' && c.transactionProof.asset.toLowerCase()===USDC.toLowerCase() &&
      Number.isFinite(Date.parse(issued)) && Date.parse(issued)<=now+30_000 && Date.parse(issued)>=now-300_000 &&
      Date.parse(c.expiresAt)>now && Date.parse(c.expiresAt)<=now+330_000, 'Invalid or expired enrollment challenge.');
    const expected=[rotating?'402Mob merchant credential rotation':'402Mob merchant enrollment',`Origin: ${this.#state.origin}`,
      `Wallet: ${this.#account.address.toLowerCase()}`,...(rotating?[]:[`Merchant name: ${this.#state.name}`]),
      `Challenge: ${c.challengeId}`,`Issued: ${issued}`,`Expires: ${c.expiresAt}`,
      `Transaction proof address: ${c.transactionProof.proofAddress}`,
      'This creates or replaces a merchant API key. It does not authorize a payment.'].join('\n');
    check(c.message===expected, 'Enrollment challenge does not match this wallet, origin and purpose.');
    return this.#account.signMessage({message:expected});
  }
  async #bootstrap(name) {
    check(name === undefined || typeof name === 'string','Name must be a string.');
    const requestedName=name?.trim();
    const savedName=typeof this.#state.name === 'string' ? this.#state.name.trim() : this.#state.name;
    check(!requestedName || !savedName || requestedName===savedName,'This wallet already has a different merchant name.');
    const normalizedName=savedName ?? requestedName ?? `Agent ${this.#account.address.slice(2,10)}`;
    check(typeof normalizedName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(normalizedName), 'Name must be 1–64 supported letters, digits, spaces, dots, underscores or hyphens.');
    this.#state.name=normalizedName;
    await this.#save();
    if (this.#state.apiKey) {
      try { const current=await this.#merchant().getMerchant(); check(current.merchant.payoutAddress.toLowerCase()===this.#account.address.toLowerCase(), 'Stored merchant credential belongs to a different wallet.'); return this.status(); }
      catch(e) { if (!(e instanceof MerchantApiError) || e.status!==401) throw e; }
    }
    let c,rotating=false;
    try { c=await this.#client.createEnrollmentChallenge({wallet:this.#account.address,name:this.#state.name}); }
    catch(e) {
      if (!(e instanceof MerchantApiError) || e.code!=='merchant_wallet_registered') throw e;
      rotating=true; c=await this.#client.createCredentialRotationChallenge(this.#account.address);
    }
    const signature=await this.#enrollmentSignature(c,rotating);
    const result=rotating ? await this.#client.rotateCredentialWithSignature(this.#account.address,c.challengeId,signature) :
      await this.#client.completeEnrollmentWithSignature({wallet:this.#account.address,name:this.#state.name,challengeId:c.challengeId,signature});
    check(result.merchant.payoutAddress?.toLowerCase()===this.#account.address.toLowerCase() && typeof result.apiKey==='string' && result.apiKey.length>=16, 'Invalid enrollment result; rerun bootstrap to recover credentials.');
    this.#state.apiKey=result.apiKey;
    this.#state.merchant={id:result.merchant.id,name:result.merchant.name,payoutAddress:result.merchant.payoutAddress};
    await this.#save(); return this.status();
  }
  discover(query='') { return this.#exclusive(()=>this.#client.resolveResources({query})); }
  provider(merchantId) { return this.#exclusive(()=>{check(uuid.test(merchantId),'Provide a merchant UUID.'); return this.#client.getProviderResources(merchantId);}); }
  offers() { return this.#exclusive(()=>this.#merchant().getMerchant()); }
  publish(input) { return this.#exclusive(()=>this.#merchant().createOffer(input)); }
  discovery(enabled) { return this.#exclusive(()=>{check(typeof enabled==='boolean','Discovery must be true or false.'); return this.#merchant().setDiscoverable(enabled);}); }
  sales() { return this.#exclusive(()=>this.#merchant().listSales()); }
  inbox() { return this.#exclusive(()=>this.#merchant().listWorkTickets()); }
  claim(id) { return this.#exclusive(()=>this.#merchant().claimWorkTicket(id)); }
  quote(id,input) { return this.#exclusive(()=>this.#merchant().quoteWorkTicket(id,input)); }
  deliver(id,input) { return this.#exclusive(()=>this.#merchant().submitWorkTicketResult(id,input)); }
  balance(rpc) { return this.#exclusive(()=>this.#balance(rpc)); }
  async #balance(rpc='https://mainnet.base.org') {
    const endpoint=new URL(rpc); check(!endpoint.username && !endpoint.password && (endpoint.protocol==='https:' || (endpoint.protocol==='http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname))), 'Use HTTPS for Base RPC.');
    const client=createPublicClient({chain:base,transport:http(rpc,{retryCount:0,timeout:15000})});
    check(await client.getChainId()===8453,'RPC is not Base mainnet.');
    const [eth,usdc]=await Promise.all([client.getBalance({address:this.#account.address}),client.readContract({address:USDC,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[this.#account.address]})]);
    return {address:this.#account.address,ETH:formatUnits(eth,18),USDC:formatUnits(usdc,6)};
  }
  #journalPath(id) { return join(this.#dir,`purchase-${purchaseId(id)}.json`); }
  #validateJournal(j) {
    check(record(j) && j.version===1 && j.origin===this.#state.origin && typeof j.payer==='string' && j.payer.toLowerCase()===this.#account.address.toLowerCase() &&
      uuid.test(j.merchantId) && uuid.test(j.offerId) && typeof j.payee==='string' && isAddress(j.payee) && typeof j.amount==='string' && /^[1-9][0-9]{0,11}$/.test(j.amount) &&
      typeof j.key==='string' && /^wallet_[0-9a-f]{48}$/.test(j.key) && typeof j.paymentHeader==='string' && validBase64(j.paymentHeader) && j.paymentHeader.length<=64_000 &&
      (j.operationId===undefined || uuid.test(j.operationId)), 'Invalid purchase journal; preserve it and restore from a backup. No new payment was authorized.');
  }
  #cachedResultBytes(result) {
    if (!record(result) || result.status!=='delivered' || !record(result.settlement) || result.settlement.success!==true || result.settlement.network!=='eip155:8453' ||
      typeof result.settlement.transaction!=='string' || !/^0x[0-9a-f]{64}$/i.test(result.settlement.transaction) || typeof result.contentType!=='string' ||
      !/^[0-9a-f]{64}$/.test(result.sha256)) return undefined;
    let bytes;
    if (result.contentBase64 !== undefined) {
      if (!validBase64(result.contentBase64)) return undefined;
      bytes=Buffer.from(result.contentBase64,'base64');
      if (bytes.toString('base64')!==result.contentBase64) return undefined;
    } else if (typeof result.content==='string') bytes=Buffer.from(result.content,'utf8');
    else return undefined;
    if (typeof result.content!=='string' || result.content!==bytes.toString('utf8') || createHash('sha256').update(bytes).digest('hex')!==result.sha256) return undefined;
    return bytes;
  }
  async #purchase({id,merchantId,offerId,maxUSDC,payee}) {
    check(typeof this.#account.signTypedData==='function','This wallet signer cannot authorize EIP-3009 typed data; configure typed-data signing before purchases.');
    check(uuid.test(merchantId) && uuid.test(offerId) && isAddress(payee),'Provide valid merchant/offer UUIDs and expected payee address.');
    const cap=money(maxUSDC),path=this.#journalPath(id);
    let j=await readPrivate(path);
    if (j !== undefined) {
      this.#validateJournal(j);
      check(j.merchantId===merchantId && j.offerId===offerId && j.payee.toLowerCase()===payee.toLowerCase() && BigInt(j.amount)<=cap,'Purchase ID already belongs to different terms.');
      return this.#resume(id);
    }
    const route=`/v1/merchants/${merchantId}/offers/${offerId}/checkout`,key=`wallet_${randomBytes(24).toString('hex')}`;
    const r=await this.#request(route,{}, {'Idempotency-Key':key});
    const h=r.headers.get('PAYMENT-REQUIRED'); await r.body?.cancel();
    check(r.status===402 && h && h.length<=16000,'Expected a supported x402 payment challenge; nothing signed.');
    const c=JSON.parse(Buffer.from(h,'base64').toString());
    check(c.x402Version===2 && c.resource?.url===this.#state.origin+route && Array.isArray(c.accepts),'Payment challenge origin or resource mismatch.');
    const a=c.accepts.find(a=>a.scheme==='exact' && a.network==='eip155:8453' && a.asset?.toLowerCase()===USDC.toLowerCase() &&
      a.payTo?.toLowerCase()===payee.toLowerCase() && typeof a.amount==='string' && /^[1-9][0-9]{0,11}$/.test(a.amount) && BigInt(a.amount)<=cap &&
      a.maxTimeoutSeconds===300 && a.extra?.name==='USD Coin' && a.extra.version==='2');
    check(a,'Payment does not match the expected payee, asset, network or price cap.');
    const now=BigInt(Math.floor(Date.now()/1000)),authorization={from:this.#account.address,to:payee,value:BigInt(a.amount),validAfter:now-60n,validBefore:now+299n,nonce:`0x${randomBytes(32).toString('hex')}`};
    const signature=await this.#account.signTypedData({domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:USDC},types:fields,primaryType:'TransferWithAuthorization',message:authorization});
    const payload={x402Version:2,resource:c.resource,accepted:a,payload:{signature,authorization:{...authorization,value:authorization.value.toString(),validAfter:authorization.validAfter.toString(),validBefore:authorization.validBefore.toString()}},...(c.extensions?{extensions:c.extensions}:{})};
    j={version:1,origin:this.#state.origin,payer:this.#account.address,merchantId,offerId,payee,amount:a.amount,key,paymentHeader:Buffer.from(JSON.stringify(payload)).toString('base64')};
    await writePrivate(path,j); // Durable authorization BEFORE its first network submission.
    return this.#resume(id);
  }
  async #resume(id) {
    const path=this.#journalPath(id),j=await readPrivate(path); check(j !== undefined,'Purchase ID not found.');
    this.#validateJournal(j);
    if (j.result !== undefined) {
      if (this.#cachedResultBytes(j.result) && uuid.test(j.operationId)) return {purchaseId:id,operationId:j.operationId,replay:true,...j.result};
      // Keep the original authorization and idempotency key; retrieve the same operation again.
      delete j.result; await writePrivate(path,j);
    }
    const route=`/v1/merchants/${j.merchantId}/offers/${j.offerId}/checkout`;
    const r=await this.#request(route,{}, {'Idempotency-Key':j.key,'PAYMENT-SIGNATURE':j.paymentHeader});
    const op=r.headers.get('X-402Mob-Operation');
    if (op && uuid.test(op)) { j.operationId=op; await writePrivate(path,j); }
    check([200,202].includes(r.status),`Purchase returned HTTP ${r.status}. Keep this purchase ID; no replacement payment was signed.`);
    const bytes=await bodyBytes(r);
    if (r.status===202) return {purchaseId:id,operationId:j.operationId ?? null,status:'pending',next:'resume using this purchase ID'};
    check(j.operationId,'Missing operation identifier; retain the journal and retry the same purchase ID.');
    const receiptHeader=r.headers.get('PAYMENT-RESPONSE');
    check(receiptHeader && receiptHeader.length<=16000,'Missing settlement receipt; preserve this purchase ID.');
    const receipt=JSON.parse(Buffer.from(receiptHeader,'base64').toString());
    check(receipt.success===true && receipt.network==='eip155:8453' && /^0x[0-9a-f]{64}$/i.test(receipt.transaction) && (!receipt.payer || receipt.payer.toLowerCase()===this.#account.address.toLowerCase()),'Invalid settlement receipt; preserve this purchase ID.');
    const contentType=r.headers.get('content-type') ?? 'application/octet-stream';
    j.result={status:'delivered',settlement:{success:true,network:receipt.network,transaction:receipt.transaction},contentType,
      sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('utf8'),contentBase64:bytes.toString('base64')};
    await writePrivate(path,j);
    return {purchaseId:id,operationId:j.operationId,replay:r.headers.get('X-402Mob-Replay')==='true',...j.result};
  }
  async #acknowledge(id, verdict) {
    check(['accepted','disputed'].includes(verdict),'Verdict must be accepted or disputed.');
    const path=this.#journalPath(id),initial=await readPrivate(path); check(initial !== undefined,'Retrieve the result before acknowledging it.');
    this.#validateJournal(initial); check(uuid.test(initial.operationId),'Retrieve the result before acknowledging it.');
    let checkedHash;
    if (this.#cachedResultBytes(initial.result)) {
      checkedHash=initial.result.sha256;
      if (await this.#hasReceipt(initial,verdict,checkedHash))
        return {purchaseId:id,operationId:initial.operationId,verdict,recorded:true,replay:true};
    }
    await this.#resume(id);
    const j=await readPrivate(path); this.#validateJournal(j);
    check(j.result && this.#cachedResultBytes(j.result) && uuid.test(j.operationId),'Retrieve the verified result before acknowledging it.');
    const route=`/v1/operations/${j.operationId}`;
    if (j.result.sha256!==checkedHash && await this.#hasReceipt(j,verdict,j.result.sha256))
      return {purchaseId:id,operationId:j.operationId,verdict,recorded:true,replay:true};
    const c=await this.#json(`${route}/delivery-receipt-challenges`,{payer:this.#account.address,verdict});
    check(/^[a-f0-9]{64}$/.test(c.id) && Date.parse(c.expiresAt)>Date.now() && Date.parse(c.expiresAt)<=Date.now()+180_000,'Invalid receipt challenge.');
    const expected=['402Mob delivery receipt authorization',`Origin: ${this.#state.origin}`,`Operation: ${j.operationId}`,`Wallet: ${this.#account.address.toLowerCase()}`,`Result SHA-256: ${j.result.sha256}`,`Action: delivery:${verdict}`,`Nonce: ${c.id}`,`Expires: ${c.expiresAt}`,'This signature records the payer wallet\'s delivery acknowledgment. It does not authorize a payment or certify work quality.'].join('\n');
    check(c.message===expected,'Receipt challenge does not match the delivered result.');
    const signature=await this.#account.signMessage({message:expected});
    await this.#json(`${route}/delivery-receipts`,{challengeId:c.id,signature});
    return {purchaseId:id,operationId:j.operationId,verdict,recorded:true};
  }
  async #hasReceipt(j,verdict,resultHash) {
    const route=`/v1/operations/${j.operationId}`,c=await this.#json(`${route}/delivery-receipts/read-challenges`,{payer:this.#account.address});
    check(/^[a-f0-9]{64}$/.test(c.id) && Date.parse(c.expiresAt)>Date.now() && Date.parse(c.expiresAt)<=Date.now()+180_000,'Invalid delivery receipt read challenge.');
    const expected=['402Mob delivery receipt authorization',`Origin: ${this.#state.origin}`,`Operation: ${j.operationId}`,`Wallet: ${this.#account.address.toLowerCase()}`,
      `Result SHA-256: ${resultHash}`,'Action: delivery:read',`Nonce: ${c.id}`,`Expires: ${c.expiresAt}`,
      'This signature records the payer wallet\'s delivery acknowledgment. It does not authorize a payment or certify work quality.'].join('\n');
    check(c.message===expected,'Receipt history challenge does not match this purchase.');
    const signature=await this.#account.signMessage({message:expected});
    const response=await this.#request(`${route}/delivery-receipts`,undefined,{'X-402Mob-Challenge':c.id,'X-402Mob-Signature':signature});
    check(response.ok,`Could not check delivery receipt history (HTTP ${response.status}); retry safely.`);
    const body=JSON.parse((await bodyBytes(response)).toString());
    check(Array.isArray(body.receipts),'Service returned an invalid delivery receipt history.');
    return body.receipts.some(receipt=>record(receipt) && receipt.operationId===j.operationId && typeof receipt.payer==='string' &&
      receipt.payer.toLowerCase()===this.#account.address.toLowerCase() && receipt.resultHash===resultHash && receipt.verdict===verdict);
  }
}
