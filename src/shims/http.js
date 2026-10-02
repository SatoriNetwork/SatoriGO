// Browser stand-in for Node's `http` and `https`, aliased in vite.config.ts for
// the monero-ts page bundle only (the Monero engine design notes §6.1).
// monero-ts constructs `new http.Agent({ keepAlive })` before handing requests
// to axios; in a browser axios ignores the agent, and HttpClient.applyTimeouts
// returns early because this Agent has no createConnection. No request ever
// goes through this module.
export class Agent {
  constructor(options) {
    this.options = options;
  }
}

export default { Agent };
