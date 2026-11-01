import { AgentWallet } from '402mob-agent-wallet';
import { homedir } from 'node:os';

// Adapt these two methods to the runtime's encrypted secret store.
const secretStore = {
  async get(name) {
    return runtimeSecrets.get(name); // JSON string or undefined
  },
  async set(name, value) {
    await runtimeSecrets.set(name, value);
  },
};

const wallet = await AgentWallet.open({
  directory: process.env.A2A_WALLET_DIR ?? `${homedir()}/.local/share/402mob/research-agent`,
  origin: 'https://evidence.contact',
  secretStore,
});

try {
  // First call generates an EOA and saves its key to secretStore before enrollment.
  // Later calls reopen the same wallet. The API key is saved there after enrollment.
  console.log(JSON.stringify(await wallet.bootstrap('Research Agent')));
} finally {
  await wallet.close();
}
