// Replace these calls with your runtime's encrypted secret-vault methods.
export const secretStore = {
  async get(key) {
    return runtimeSecrets.get(key); // serialized JSON string or undefined
  },
  async set(key, value) {
    await runtimeSecrets.set(key, value);
  },
};

// Optional managed signer. For local EOA creation, omit signer and let the wallet
// generate a key that it stores through secretStore.
// export const signer = {
//   address: runtimeWallet.address,
//   signMessage: ({ message }) => runtimeWallet.signMessage(message),
//   signTypedData: (typedData) => runtimeWallet.signTypedData(typedData),
// };

export default { secretStore };
