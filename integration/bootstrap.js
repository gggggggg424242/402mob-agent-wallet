const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Integration tests may only call loopback services.');
  return originalFetch(input,options);
};
